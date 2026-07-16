import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  StartAppleJournalMediaUploadInput,
  StartAppleJournalMediaUploadResponse,
} from "../shared/api";
import {
  MAX_MEDIA_BYTES,
  MULTIPART_PART_BYTES,
  multipartPartCount,
  multipartPartSize,
} from "../worker/lib/media";
import {
  UPLOAD_BOOKKEEPING_RETENTION_MS,
  cleanupExpiredMediaUploads,
  cleanupQueuedMedia,
} from "../worker/routes/import-media-uploads";

const worker = exports.default;
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const QUICKTIME_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
]);

interface UploadStateRow {
  upload_id: string;
  r2_key: string;
  status: string;
  version: number;
  next_part: number;
  active_part: number | null;
}

function fingerprint(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

async function createImportAndEntry(
  seed: number,
): Promise<{ importId: string; entryId: string; generationId: string }> {
  const start = await worker.fetch(
    new Request("http://localhost/api/imports/apple-journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: "SyntheticAppleJournal.zip",
        fileFingerprint: fingerprint(seed),
        entryCount: 1,
        mediaCount: 1,
      }),
    }),
  );
  expect(start.status).toBe(201);
  const importJob = await start.json<{ id: string }>();
  const entry = await worker.fetch(
    new Request(`http://localhost/api/imports/apple-journal/${importJob.id}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourcePath: `Synthetic/Entries/${seed}.html`,
        mediaCount: 1,
        title: `合成媒體測試 ${seed}`,
        body: "這是隔離測試內容。",
        occurredAt: "2026-07-17T00:00:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-17",
        location: null,
        mood: null,
      }),
    }),
  );
  expect(entry.status).toBe(201);
  const imported = await entry.json<{ id: string; generationId: string }>();
  return { importId: importJob.id, entryId: imported.id, generationId: imported.generationId };
}

function uploadBase(importId: string, entryId: string): string {
  return `http://localhost/api/imports/apple-journal/${importId}/entries/${entryId}/media/uploads`;
}

async function startMediaUpload(
  baseUrl: string,
  input: StartAppleJournalMediaUploadInput,
): Promise<{ response: Response; payload: StartAppleJournalMediaUploadResponse }> {
  const response = await worker.fetch(
    new Request(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return { response, payload: await response.json<StartAppleJournalMediaUploadResponse>() };
}

function mediaInput(
  seed: number,
  bytes: Uint8Array,
  generationId: string,
  type: "photo" | "video" = "photo",
): StartAppleJournalMediaUploadInput {
  return {
    generationId,
    fingerprint: fingerprint(seed),
    sourcePath: type === "video" ? `Synthetic/Resources/${seed}.mov` : `Synthetic/Resources/${seed}.png`,
    type,
    mimeType: type === "video" ? "video/quicktime" : "image/png",
    sizeBytes: bytes.byteLength,
    position: 0,
    placement: "cover",
    caption: "",
  };
}

async function putPart(
  url: string,
  bytes: Uint8Array,
  mimeType: string,
  sizeHeader = bytes.byteLength,
  contentLength?: number,
): Promise<Response> {
  return worker.fetch(
    new Request(url, {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "X-Media-Size": String(sizeHeader),
        ...(contentLength === undefined ? {} : { "Content-Length": String(contentLength) }),
      },
      body: bytes,
    }),
  );
}

function readUploadState(mediaId: string): Promise<UploadStateRow | null> {
  return env.DB.prepare(`
    SELECT media_uploads.upload_id, media.r2_key, media_uploads.status,
      media_uploads.version, media_uploads.next_part, media_uploads.active_part
    FROM media_uploads
    JOIN media ON media.id = media_uploads.media_id
    WHERE media_uploads.media_id = ?1
  `).bind(mediaId).first<UploadStateRow>();
}

describe("Apple Journal multipart media uploads", () => {
  it.each([
    { label: "PNG image", seed: 101, type: "photo" as const, bytes: PNG_BYTES },
    { label: "QuickTime video", seed: 102, type: "video" as const, bytes: QUICKTIME_BYTES },
  ])("uploads and renders a synthetic $label through the complete API path", async ({ seed, type, bytes }) => {
    const { importId, entryId, generationId } = await createImportAndEntry(seed);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(seed + 1_000, bytes, generationId, type);
    const started = await startMediaUpload(base, input);
    expect(started.response.status).toBe(201);
    expect(started.payload).toMatchObject({ disposition: "uploading", partCount: 1 });
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");

    const part = await putPart(
      `${base}/${started.payload.id}/parts/1`,
      bytes,
      input.mimeType,
      bytes.byteLength,
      0,
    );
    expect(part.status).toBe(201);

    const completed = await worker.fetch(
      new Request(`${base}/${started.payload.id}/complete`, { method: "POST" }),
    );
    expect(completed.status).toBe(201);

    const detail = await worker.fetch(new Request(`http://localhost/api/entries/${entryId}`));
    const entry = await detail.json<{ media: Array<{ id: string; type: string; src: string }> }>();
    expect(entry.media).toEqual([
      expect.objectContaining({ id: started.payload.id, type }),
    ]);
    const object = await worker.fetch(new Request(`http://localhost${entry.media[0]?.src}`));
    expect(object.status).toBe(200);
    expect(object.headers.get("Content-Type")).toBe(input.mimeType);
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(bytes);

    const duplicate = await startMediaUpload(base, input);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.payload).toEqual({ id: started.payload.id, disposition: "duplicate" });
  });

  it("rejects oversized declarations, MIME mismatches, invalid signatures, and invalid part sizes", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(103);
    const base = uploadBase(importId, entryId);
    const oversized = mediaInput(1_103, PNG_BYTES, generationId);
    oversized.sizeBytes = MAX_MEDIA_BYTES + 1;
    const tooLarge = await startMediaUpload(base, oversized);
    expect(tooLarge.response.status).toBe(413);

    const wrongMime = mediaInput(1_104, QUICKTIME_BYTES, generationId, "video");
    wrongMime.mimeType = "image/png";
    const mismatch = await startMediaUpload(base, wrongMime);
    expect(mismatch.response.status).toBe(400);

    const input = mediaInput(1_105, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const wrongSize = await putPart(
      `${base}/${started.payload.id}/parts/1`,
      PNG_BYTES,
      input.mimeType,
      PNG_BYTES.byteLength - 1,
    );
    expect(wrongSize.status).toBe(400);
    const wrongSignature = await putPart(
      `${base}/${started.payload.id}/parts/1`,
      QUICKTIME_BYTES.subarray(0, PNG_BYTES.byteLength),
      input.mimeType,
    );
    expect(wrongSignature.status).toBe(400);

    const sizeMismatchInput = mediaInput(1_109, PNG_BYTES, generationId);
    const sizeMismatchStarted = await startMediaUpload(base, sizeMismatchInput);
    if (sizeMismatchStarted.payload.disposition !== "uploading") {
      throw new Error("Expected an upload session");
    }
    const oversizedBody = new Uint8Array([...PNG_BYTES, 0]);
    const acceptedStream = await putPart(
      `${base}/${sizeMismatchStarted.payload.id}/parts/1`,
      oversizedBody,
      sizeMismatchInput.mimeType,
      sizeMismatchInput.sizeBytes,
      0,
    );
    expect(acceptedStream.status).toBe(201);
    const rejectedObject = await worker.fetch(
      new Request(`${base}/${sizeMismatchStarted.payload.id}/complete`, { method: "POST" }),
    );
    expect(rejectedObject.status).toBe(500);
    const failedMedia = await env.DB.prepare(`SELECT status FROM media WHERE id = ?1`)
      .bind(sizeMismatchStarted.payload.id)
      .first<{ status: string }>();
    expect(failedMedia?.status).toBe("failed");
  });

  it("enforces ordered parts, resumes partial uploads, and completes after the final part", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(104);
    const base = uploadBase(importId, entryId);
    const totalSize = MULTIPART_PART_BYTES + QUICKTIME_BYTES.byteLength;
    const input = mediaInput(1_106, QUICKTIME_BYTES, generationId, "video");
    input.sizeBytes = totalSize;
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    expect(started.payload).toMatchObject({
      partSize: MULTIPART_PART_BYTES,
      partCount: 2,
      uploadedParts: [],
    });
    const uploadUrl = `${base}/${started.payload.id}`;

    const outOfBounds = await putPart(
      `${uploadUrl}/parts/3`,
      QUICKTIME_BYTES,
      input.mimeType,
    );
    expect(outOfBounds.status).toBe(400);

    const outOfOrder = await putPart(
      `${uploadUrl}/parts/2`,
      QUICKTIME_BYTES,
      input.mimeType,
    );
    expect(outOfOrder.status).toBe(409);

    const firstPart = new Uint8Array(MULTIPART_PART_BYTES);
    firstPart.set(QUICKTIME_BYTES);
    const uploadedFirst = await putPart(
      `${uploadUrl}/parts/1`,
      firstPart,
      input.mimeType,
    );
    expect(uploadedFirst.status).toBe(201);

    const incomplete = await worker.fetch(
      new Request(`${uploadUrl}/complete`, { method: "POST" }),
    );
    expect(incomplete.status).toBe(409);

    const resumed = await startMediaUpload(base, input);
    expect(resumed.payload).toMatchObject({
      id: started.payload.id,
      disposition: "uploading",
      uploadedParts: [1],
    });

    const uploadedLast = await putPart(
      `${uploadUrl}/parts/2`,
      QUICKTIME_BYTES,
      input.mimeType,
    );
    expect(uploadedLast.status).toBe(201);
    const storedPart = await env.DB.prepare(`
      SELECT etag FROM media_upload_parts WHERE media_id = ?1 AND part_number = 2
    `).bind(started.payload.id).first<{ etag: string }>();
    if (!storedPart) throw new Error("Expected the uploaded part ETag");
    expect(storedPart.etag).toBeTruthy();
    await env.DB.prepare(`
      UPDATE media_upload_parts SET etag = '' WHERE media_id = ?1 AND part_number = 2
    `).bind(started.payload.id).run();
    const invalidEtag = await worker.fetch(
      new Request(`${uploadUrl}/complete`, { method: "POST" }),
    );
    expect(invalidEtag.status).toBe(409);
    await env.DB.prepare(`
      UPDATE media_upload_parts SET etag = ?2 WHERE media_id = ?1 AND part_number = 2
    `).bind(started.payload.id, storedPart.etag).run();
    const completed = await worker.fetch(
      new Request(`${uploadUrl}/complete`, { method: "POST" }),
    );
    expect(completed.status).toBe(201);
    const completedAgain = await worker.fetch(
      new Request(`${uploadUrl}/complete`, { method: "POST" }),
    );
    expect(completedAgain.status).toBe(200);
  });

  it("aborts an interrupted session and can restart the failed media row", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(105);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_107, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;

    const aborted = await worker.fetch(new Request(`${uploadUrl}/abort`, { method: "POST" }));
    expect(aborted.status).toBe(204);
    const closed = await putPart(`${uploadUrl}/parts/1`, PNG_BYTES, input.mimeType);
    expect(closed.status).toBe(409);

    const restarted = await startMediaUpload(base, input);
    expect(restarted.response.status).toBe(201);
    expect(restarted.payload).toMatchObject({
      id: started.payload.id,
      disposition: "uploading",
      uploadedParts: [],
    });
  });

  it("deduplicates simultaneous upload initialization and part claims", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(107);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_110, PNG_BYTES, generationId);
    const [left, right] = await Promise.all([
      startMediaUpload(base, input),
      startMediaUpload(base, input),
    ]);
    expect([left.response.status, right.response.status].sort()).toEqual([200, 201]);
    expect(left.payload.id).toBe(right.payload.id);
    if (left.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const partUrl = `${base}/${left.payload.id}/parts/1`;

    const concurrent = await Promise.all([
      putPart(partUrl, PNG_BYTES, input.mimeType),
      putPart(partUrl, PNG_BYTES, input.mimeType),
    ]);
    expect(concurrent.some((response) => response.status === 201)).toBe(true);
    const retry = await putPart(partUrl, PNG_BYTES, input.mimeType);
    expect(retry.status).toBe(200);

    const state = await readUploadState(left.payload.id);
    expect(state).toMatchObject({ status: "uploading", next_part: 2, active_part: null });
    const partCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM media_upload_parts WHERE media_id = ?1
    `).bind(left.payload.id).first<{ count: number }>();
    expect(partCount?.count).toBe(1);
  });

  it("recovers an expired part lease after a crash before the R2 write", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(108);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_111, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'part_uploading', active_part = 1,
        active_part_expires_at = ?2, version = version + 1
      WHERE media_id = ?1
    `).bind(started.payload.id, new Date(Date.now() - 60_000).toISOString()).run();

    const recovered = await putPart(
      `${base}/${started.payload.id}/parts/1`,
      PNG_BYTES,
      input.mimeType,
    );
    expect(recovered.status).toBe(201);
    expect(await readUploadState(started.payload.id)).toMatchObject({
      status: "uploading",
      next_part: 2,
      active_part: null,
    });
  });

  it("rewrites the part and records a fresh ETag after an R2-write-before-D1 crash", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(109);
    const base = uploadBase(importId, entryId);
    const recoveredBytes = new Uint8Array([...PNG_BYTES, 1]);
    const orphanedBytes = new Uint8Array([...PNG_BYTES, 0]);
    const input = mediaInput(1_112, recoveredBytes, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const initial = await readUploadState(started.payload.id);
    if (!initial) throw new Error("Expected upload state");
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'part_uploading', active_part = 1,
        active_part_expires_at = ?2, version = version + 1
      WHERE media_id = ?1
    `).bind(started.payload.id, new Date(Date.now() - 60_000).toISOString()).run();
    const orphanedPart = await env.MEDIA
      .resumeMultipartUpload(initial.r2_key, initial.upload_id)
      .uploadPart(1, orphanedBytes);

    const recovered = await putPart(
      `${base}/${started.payload.id}/parts/1`,
      recoveredBytes,
      input.mimeType,
    );
    expect(recovered.status).toBe(201);
    const stored = await env.DB.prepare(`
      SELECT etag FROM media_upload_parts WHERE media_id = ?1 AND part_number = 1
    `).bind(started.payload.id).first<{ etag: string }>();
    expect(stored?.etag).toBeTruthy();
    expect(stored?.etag).not.toBe(orphanedPart.etag);
  });

  it("finalizes from R2 head after completion succeeds before the D1 commit", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(111);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_114, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;
    expect((await putPart(`${uploadUrl}/parts/1`, PNG_BYTES, input.mimeType)).status).toBe(201);
    const state = await readUploadState(started.payload.id);
    const part = await env.DB.prepare(`
      SELECT part_number, etag FROM media_upload_parts WHERE media_id = ?1
    `).bind(started.payload.id).first<{ part_number: number; etag: string }>();
    if (!state || !part) throw new Error("Expected persisted multipart state");
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'completing', state_expires_at = ?2, version = version + 1
      WHERE media_id = ?1 AND status = 'uploading'
    `).bind(
      started.payload.id,
      new Date(Date.now() + 60_000).toISOString(),
    ).run();
    await env.MEDIA
      .resumeMultipartUpload(state.r2_key, state.upload_id)
      .complete([{ partNumber: part.part_number, etag: part.etag }]);

    const recovered = await worker.fetch(
      new Request(`${uploadUrl}/complete`, { method: "POST" }),
    );
    expect(recovered.status).toBe(200);
    expect(await readUploadState(started.payload.id)).toMatchObject({ status: "completed" });
    const detail = await worker.fetch(new Request(`http://localhost/api/entries/${entryId}`));
    expect(detail.status).toBe(200);
  });

  it("retries completion after a stale completing lease crashes before R2", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(112);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_115, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;
    expect((await putPart(`${uploadUrl}/parts/1`, PNG_BYTES, input.mimeType)).status).toBe(201);
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'completing', state_expires_at = ?2, version = version + 1
      WHERE media_id = ?1 AND status = 'uploading'
    `).bind(
      started.payload.id,
      new Date(Date.now() - 60_000).toISOString(),
    ).run();

    const recovered = await worker.fetch(
      new Request(`${uploadUrl}/complete`, { method: "POST" }),
    );
    expect(recovered.status).toBe(201);
    expect(await readUploadState(started.payload.id)).toMatchObject({ status: "completed" });
  });

  it("serializes complete against abort and never reopens a terminal upload", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(110);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_113, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;
    expect((await putPart(`${uploadUrl}/parts/1`, PNG_BYTES, input.mimeType)).status).toBe(201);

    const [completed, aborted] = await Promise.all([
      worker.fetch(new Request(`${uploadUrl}/complete`, { method: "POST" })),
      worker.fetch(new Request(`${uploadUrl}/abort`, { method: "POST" })),
    ]);
    const terminal = await readUploadState(started.payload.id);
    expect(["completed", "aborted"]).toContain(terminal?.status);
    if (terminal?.status === "completed") expect(completed.status).toBe(201);
    else expect(completed.status).toBe(409);
    expect([204, 409]).toContain(aborted.status);
    const media = await env.DB.prepare(`SELECT status FROM media WHERE id = ?1`)
      .bind(started.payload.id)
      .first<{ status: string }>();
    expect(
      terminal?.status === "completed"
        ? media?.status === "ready"
        : media?.status === "failed",
    ).toBe(true);
    const item = await env.DB.prepare(`
      SELECT status FROM import_items WHERE import_id = ?1 AND source_id = ?2
    `).bind(importId, started.payload.id).first<{ status: string }>();
    expect(item?.status).toBe(terminal?.status === "completed" ? "completed" : "failed");

    const abortAgain = await worker.fetch(new Request(`${uploadUrl}/abort`, { method: "POST" }));
    expect(abortAgain.status).toBe(204);
    expect((await readUploadState(started.payload.id))?.status).toBe(terminal?.status);
  });

  it("expires an abandoned upload and allows the same media to restart", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(113);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_116, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const cleanupAt = new Date();
    await env.DB.prepare(`
      UPDATE media_uploads SET expires_at = ?2 WHERE media_id = ?1
    `).bind(started.payload.id, new Date(cleanupAt.getTime() - 1).toISOString()).run();

    const result = await cleanupExpiredMediaUploads(env, cleanupAt);
    expect(result).toMatchObject({ aborted: 1, failed: 0 });
    expect(await readUploadState(started.payload.id)).toMatchObject({ status: "aborted" });
    const failedMedia = await env.DB.prepare(`SELECT status FROM media WHERE id = ?1`)
      .bind(started.payload.id)
      .first<{ status: string }>();
    expect(failedMedia?.status).toBe("failed");
    const failedItem = await env.DB.prepare(`
      SELECT status, error_code FROM import_items WHERE import_id = ?1 AND source_id = ?2
    `).bind(importId, started.payload.id).first<{ status: string; error_code: string }>();
    expect(failedItem).toEqual({ status: "failed", error_code: "UPLOAD_EXPIRED" });

    const restarted = await startMediaUpload(base, input);
    expect(restarted.response.status).toBe(201);
    expect(restarted.payload).toMatchObject({ id: started.payload.id, disposition: "uploading" });
  });

  it("does not replace an expired session while its part lease is still active", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(120);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_120, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const before = await readUploadState(started.payload.id);
    if (!before) throw new Error("Expected persisted upload state");

    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'part_uploading', active_part = 1,
        active_part_expires_at = ?2, expires_at = ?3,
        version = version + 1
      WHERE media_id = ?1
    `).bind(
      started.payload.id,
      new Date(Date.now() + 60_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
    ).run();

    const busy = await startMediaUpload(base, input);
    expect(busy.response.status).toBe(409);
    expect(await readUploadState(started.payload.id)).toMatchObject({
      upload_id: before.upload_id,
      status: "part_uploading",
      active_part: 1,
    });

    await env.DB.prepare(`
      UPDATE media_uploads SET active_part_expires_at = ?2 WHERE media_id = ?1
    `).bind(started.payload.id, new Date(Date.now() - 1).toISOString()).run();
    const restarted = await startMediaUpload(base, input);
    expect(restarted.response.status).toBe(201);
    expect(restarted.payload).toMatchObject({
      id: started.payload.id,
      disposition: "uploading",
      uploadedParts: [],
    });
    const after = await readUploadState(started.payload.id);
    expect(after?.upload_id).not.toBe(before.upload_id);
    expect(after).toMatchObject({ status: "uploading", active_part: null });
  });

  it("cleanup reconciles an R2 completion left behind before its D1 commit", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(114);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_117, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;
    expect((await putPart(`${uploadUrl}/parts/1`, PNG_BYTES, input.mimeType)).status).toBe(201);
    const state = await readUploadState(started.payload.id);
    const part = await env.DB.prepare(`
      SELECT part_number, etag FROM media_upload_parts WHERE media_id = ?1
    `).bind(started.payload.id).first<{ part_number: number; etag: string }>();
    if (!state || !part) throw new Error("Expected persisted multipart state");
    const cleanupAt = new Date();
    const expiredAt = new Date(cleanupAt.getTime() - 1).toISOString();
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'completing', state_expires_at = ?2,
        expires_at = ?2, version = version + 1
      WHERE media_id = ?1 AND status = 'uploading'
    `).bind(started.payload.id, expiredAt).run();
    await env.MEDIA
      .resumeMultipartUpload(state.r2_key, state.upload_id)
      .complete([{ partNumber: part.part_number, etag: part.etag }]);

    const result = await cleanupExpiredMediaUploads(env, cleanupAt);
    expect(result).toMatchObject({ finalized: 1, failed: 0 });
    expect(await readUploadState(started.payload.id)).toMatchObject({ status: "completed" });
    const completedItem = await env.DB.prepare(`
      SELECT status FROM import_items WHERE import_id = ?1 AND source_id = ?2
    `).bind(importId, started.payload.id).first<{ status: string }>();
    expect(completedItem?.status).toBe("completed");
    expect((await worker.fetch(new Request(`http://localhost/api/entries/${entryId}`))).status).toBe(200);
  });

  it("cleanup preserves active leases and removes only old terminal bookkeeping", async () => {
    const active = await createImportAndEntry(115);
    const activeBase = uploadBase(active.importId, active.entryId);
    const activeInput = mediaInput(1_118, PNG_BYTES, active.generationId);
    const activeStarted = await startMediaUpload(activeBase, activeInput);
    if (activeStarted.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const cleanupAt = new Date();
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'part_uploading', active_part = 1,
        active_part_expires_at = ?2, expires_at = ?3,
        version = version + 1
      WHERE media_id = ?1
    `).bind(
      activeStarted.payload.id,
      new Date(cleanupAt.getTime() + 60_000).toISOString(),
      new Date(cleanupAt.getTime() - 1).toISOString(),
    ).run();
    expect(await cleanupExpiredMediaUploads(env, cleanupAt)).toMatchObject({
      skipped: 1,
      aborted: 0,
    });
    expect(await readUploadState(activeStarted.payload.id)).toMatchObject({
      status: "part_uploading",
      active_part: 1,
    });

    const completed = await createImportAndEntry(116);
    const completedBase = uploadBase(completed.importId, completed.entryId);
    const completedInput = mediaInput(1_119, PNG_BYTES, completed.generationId);
    const completedStarted = await startMediaUpload(completedBase, completedInput);
    if (completedStarted.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const completedUrl = `${completedBase}/${completedStarted.payload.id}`;
    expect((await putPart(`${completedUrl}/parts/1`, PNG_BYTES, completedInput.mimeType)).status).toBe(201);
    expect((await worker.fetch(new Request(`${completedUrl}/complete`, { method: "POST" }))).status).toBe(201);
    await env.DB.prepare(`
      UPDATE media_uploads SET updated_at = ?2 WHERE media_id = ?1
    `).bind(
      completedStarted.payload.id,
      new Date(cleanupAt.getTime() - UPLOAD_BOOKKEEPING_RETENTION_MS - 1).toISOString(),
    ).run();
    const eligible = await env.DB.prepare(`
      SELECT status, updated_at FROM media_uploads
      WHERE media_id = ?1 AND status IN ('completed', 'failed', 'aborted')
        AND updated_at <= ?2
    `).bind(
      completedStarted.payload.id,
      new Date(cleanupAt.getTime() - UPLOAD_BOOKKEEPING_RETENTION_MS).toISOString(),
    ).first<{ status: string; updated_at: string }>();
    expect(eligible?.status).toBe("completed");

    const terminalResult = await cleanupExpiredMediaUploads(env, cleanupAt);
    expect(await readUploadState(completedStarted.payload.id)).toBeNull();
    expect(terminalResult).toMatchObject({ deleted: 1, failed: 0 });
    const media = await env.DB.prepare(`SELECT status, r2_key FROM media WHERE id = ?1`)
      .bind(completedStarted.payload.id)
      .first<{ status: string; r2_key: string }>();
    expect(media?.status).toBe("ready");
    expect((await env.MEDIA.head(media?.r2_key ?? "missing"))?.size).toBe(PNG_BYTES.byteLength);
    expect((await worker.fetch(new Request(`http://localhost/api/entries/${completed.entryId}`))).status).toBe(200);
  });

  it("queued cleanup preserves media that still has another entry reference", async () => {
    const createdResponse = await worker.fetch(
      new Request("http://localhost/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "合成的共享媒體測試",
          body: "這是隔離測試內容。",
          occurredAt: "2026-07-17T00:00:00.000Z",
          timezone: "Asia/Taipei",
          localDate: "2026-07-17",
          location: null,
          mood: null,
        }),
      }),
    );
    const entry = await createdResponse.json<{ id: string }>();
    const mediaId = crypto.randomUUID();
    const r2Key = `imports/${mediaId}.png`;
    const now = new Date().toISOString();
    await env.MEDIA.put(r2Key, PNG_BYTES, { httpMetadata: { contentType: "image/png" } });
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO media (
          id, r2_key, storage_kind, sha256, type, mime_type, size_bytes,
          status, owner_subject, created_at, updated_at
        ) VALUES (?1, ?2, 'private_r2', ?3, 'photo', 'image/png', ?4,
          'ready', 'local-development', ?5, ?5)
      `).bind(mediaId, r2Key, fingerprint(1_121), PNG_BYTES.byteLength, now),
      env.DB.prepare(`
        INSERT INTO entry_media (entry_id, media_id, position, placement, caption)
        VALUES (?1, ?2, 0, 'cover', '')
      `).bind(entry.id, mediaId),
      env.DB.prepare(`
        INSERT INTO media_cleanup_queue (media_id, r2_key, requested_at)
        VALUES (?1, ?2, ?3)
      `).bind(mediaId, r2Key, now),
    ]);

    expect(await cleanupQueuedMedia(env)).toMatchObject({ referenced: 1, deleted: 0, failed: 0 });
    expect(await env.DB.prepare(`SELECT id FROM media WHERE id = ?1`).bind(mediaId).first()).not.toBeNull();
    expect(await env.MEDIA.head(r2Key)).not.toBeNull();
    expect(
      await env.DB.prepare(`SELECT media_id FROM media_cleanup_queue WHERE media_id = ?1`)
        .bind(mediaId)
        .first(),
    ).toBeNull();
  });

  it("repairs a legacy failed small-image row instead of misreporting it as a duplicate", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(106);
    const mediaId = crypto.randomUUID();
    const failedFingerprint = fingerprint(1_108);
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO media (
        id, r2_key, storage_kind, sha256, type, mime_type, size_bytes,
        status, created_at, updated_at
      ) VALUES (?1, ?2, 'private_r2', ?3, 'photo', 'image/png', 8, 'failed', ?4, ?4)
    `).bind(mediaId, `imports/${mediaId}.png`, failedFingerprint, now).run();

    const repaired = await worker.fetch(
      new Request(
        `http://localhost/api/imports/apple-journal/${importId}/entries/${entryId}/media?generationId=${encodeURIComponent(generationId)}&sourcePath=Synthetic%2FResources%2Fretry.png&type=photo&position=0&placement=cover&caption=`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "0",
            "X-Media-Size": "8",
            "X-Media-Fingerprint": failedFingerprint,
          },
          body: PNG_BYTES,
        },
      ),
    );
    expect(repaired.status).toBe(201);
    expect(await repaired.json()).toEqual({ id: mediaId, disposition: "inserted" });
    const row = await env.DB.prepare(`SELECT owner_subject, status FROM media WHERE id = ?1`)
      .bind(mediaId)
      .first<{ owner_subject: string; status: string }>();
    expect(row).toEqual({ owner_subject: "local-development", status: "ready" });
    const object = await env.MEDIA.get(`imports/${mediaId}.png`);
    expect(object?.size).toBe(PNG_BYTES.byteLength);
  });
});

describe("multipart geometry", () => {
  it("models a media file larger than 100 MiB without allocating its contents", () => {
    const virtualSize = 157 * 1024 * 1024 + 431;
    const partCount = multipartPartCount(virtualSize);
    const sizes = Array.from(
      { length: partCount },
      (_, index) => multipartPartSize(virtualSize, index + 1),
    );

    expect(virtualSize).toBeGreaterThan(100 * 1024 * 1024);
    expect(partCount).toBe(20);
    expect(sizes.slice(0, -1).every((size) => size === MULTIPART_PART_BYTES)).toBe(true);
    expect(sizes.at(-1)).toBe(5 * 1024 * 1024 + 431);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(virtualSize);
  });
});
