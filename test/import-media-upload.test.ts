import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
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
import workerHandler from "../worker/index";

const worker = exports.default;
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const QUICKTIME_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
]);

interface UploadStateRow {
  upload_id: string;
  r2_key: string;
  entry_generation_id: string;
  status: string;
  version: number;
  next_part: number;
  active_part: number | null;
  active_part_expires_at: string | null;
  state_expires_at: string | null;
  updated_at: string;
}

type DeferredMultipartAction = "part" | "complete" | "complete-failure" | "abort";

interface DeferredMultipartGate {
  bucket: R2Bucket;
  reached: Promise<void>;
  release(): void;
}

function fingerprint(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function syntheticEntryInput(seed: number) {
  return {
    sourcePath: `Synthetic/Entries/${seed}.html`,
    mediaCount: 1,
    title: `合成媒體測試 ${seed}`,
    body: "這是隔離測試內容。",
    occurredAt: "2026-07-17T00:00:00.000Z",
    timezone: "Asia/Taipei",
    localDate: "2026-07-17",
    location: null,
    mood: null,
  };
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
      body: JSON.stringify(syntheticEntryInput(seed)),
    }),
  );
  expect(entry.status).toBe(201);
  const imported = await entry.json<{ id: string; generationId: string }>();
  return { importId: importJob.id, entryId: imported.id, generationId: imported.generationId };
}

async function retryImportEntry(importId: string, seed: number): Promise<string> {
  const response = await worker.fetch(
    new Request(`http://localhost/api/imports/apple-journal/${importId}/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(syntheticEntryInput(seed)),
    }),
  );
  expect(response.status).toBe(200);
  const entry = await response.json<{ generationId: string; disposition: string }>();
  expect(entry.disposition).toBe("duplicate");
  return entry.generationId;
}

function uploadBase(importId: string, entryId: string): string {
  return `http://localhost/api/imports/apple-journal/${importId}/entries/${entryId}/media/uploads`;
}

function withGeneration(url: string, generationId: string): string {
  return `${url}?generationId=${encodeURIComponent(generationId)}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function deferredMultipartGate(action: DeferredMultipartAction): DeferredMultipartGate {
  const reached = deferred<void>();
  const released = deferred<void>();
  let intercepted = false;

  async function pauseAfter<T>(operation: () => Promise<T>): Promise<T> {
    const result = await operation();
    reached.resolve();
    await released.promise;
    return result;
  }

  async function pauseBeforeFailure<T>(): Promise<T> {
    reached.resolve();
    await released.promise;
    throw new Error("Synthetic deferred R2 failure");
  }

  const bucket: R2Bucket = {
    head: env.MEDIA.head.bind(env.MEDIA),
    get: env.MEDIA.get.bind(env.MEDIA),
    put: env.MEDIA.put.bind(env.MEDIA),
    createMultipartUpload: env.MEDIA.createMultipartUpload.bind(env.MEDIA),
    resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
      const multipart = env.MEDIA.resumeMultipartUpload(key, uploadId);
      return {
        key: multipart.key,
        uploadId: multipart.uploadId,
        uploadPart(...args: Parameters<R2MultipartUpload["uploadPart"]>) {
          if (action !== "part" || intercepted) return multipart.uploadPart(...args);
          intercepted = true;
          return pauseAfter(() => multipart.uploadPart(...args));
        },
        complete(...args: Parameters<R2MultipartUpload["complete"]>) {
          if ((action !== "complete" && action !== "complete-failure") || intercepted) {
            return multipart.complete(...args);
          }
          intercepted = true;
          if (action === "complete-failure") return pauseBeforeFailure();
          return pauseAfter(() => multipart.complete(...args));
        },
        abort() {
          if (action !== "abort" || intercepted) return multipart.abort();
          intercepted = true;
          return pauseAfter(() => multipart.abort());
        },
      };
    },
    delete: env.MEDIA.delete.bind(env.MEDIA),
    list: env.MEDIA.list.bind(env.MEDIA),
  };

  return {
    bucket,
    reached: reached.promise,
    release: () => released.resolve(),
  };
}

function fetchWithMedia(request: Request, bucket: R2Bucket): Promise<Response> {
  const testEnv: Env = {
    MEDIA: bucket,
    DB: env.DB,
    ASSETS: env.ASSETS,
    AUTH_ISSUER: env.AUTH_ISSUER,
    AUTH_CLIENT_ID: env.AUTH_CLIENT_ID,
    AUTH_ALLOWED_SUBJECT: env.AUTH_ALLOWED_SUBJECT,
  };
  return Promise.resolve(workerHandler.fetch(
    request as Parameters<typeof workerHandler.fetch>[0],
    testEnv,
    createExecutionContext(),
  ));
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
      media_uploads.entry_generation_id, media_uploads.version,
      media_uploads.next_part, media_uploads.active_part,
      media_uploads.active_part_expires_at, media_uploads.state_expires_at,
      media_uploads.updated_at
    FROM media_uploads
    JOIN media ON media.id = media_uploads.media_id
    WHERE media_uploads.media_id = ?1
  `).bind(mediaId).first<UploadStateRow>();
}

async function replaceClaimedUpload(
  mediaId: string,
  generationId: string,
  mimeType: string,
): Promise<UploadStateRow> {
  const claimed = await readUploadState(mediaId);
  if (!claimed) throw new Error("Expected a claimed upload");
  const replacement = await env.MEDIA.createMultipartUpload(claimed.r2_key, {
    httpMetadata: { contentType: mimeType },
  });
  const now = new Date().toISOString();
  const [replaced, , media] = await env.DB.batch([
    env.DB.prepare(`
      UPDATE media_uploads SET
        entry_generation_id = ?4, upload_id = ?5, status = 'uploading',
        next_part = 1, active_part = NULL, active_part_expires_at = NULL,
        state_expires_at = NULL, updated_at = ?6
      WHERE media_id = ?1 AND upload_id = ?2 AND version = ?3
    `).bind(
      mediaId,
      claimed.upload_id,
      claimed.version,
      generationId,
      replacement.uploadId,
      now,
    ),
    env.DB.prepare(`DELETE FROM media_upload_parts WHERE media_id = ?1`).bind(mediaId),
    env.DB.prepare(`
      UPDATE media SET status = 'uploading', updated_at = ?2 WHERE id = ?1
    `).bind(mediaId, now),
  ]);
  expect(replaced.meta.changes).toBe(1);
  expect(media.meta.changes).toBe(1);
  const current = await readUploadState(mediaId);
  if (!current) throw new Error("Expected a replacement upload");
  expect(current).toMatchObject({
    upload_id: replacement.uploadId,
    entry_generation_id: generationId,
    status: "uploading",
    version: claimed.version,
    next_part: 1,
    active_part: null,
    active_part_expires_at: null,
    state_expires_at: null,
  });
  return current;
}

async function readRaceState(mediaId: string, importId: string, sourcePath: string) {
  const [upload, media, parts, item] = await Promise.all([
    readUploadState(mediaId),
    env.DB.prepare(`
      SELECT status, updated_at FROM media WHERE id = ?1
    `).bind(mediaId).first<{ status: string; updated_at: string }>(),
    env.DB.prepare(`
      SELECT part_number, etag, size_bytes, updated_at
      FROM media_upload_parts WHERE media_id = ?1 ORDER BY part_number
    `).bind(mediaId).all<{
      part_number: number;
      etag: string;
      size_bytes: number;
      updated_at: string;
    }>(),
    env.DB.prepare(`
      SELECT source_id, checksum, status, error_code, updated_at
      FROM import_items WHERE import_id = ?1 AND source_path = ?2
    `).bind(importId, sourcePath).first<{
      source_id: string | null;
      checksum: string | null;
      status: string;
      error_code: string | null;
      updated_at: string;
    }>(),
  ]);
  return { upload, media, parts: parts.results, item };
}

async function readObjectState(key: string) {
  const object = await env.MEDIA.head(key);
  return object
    ? { size: object.size, etag: object.etag, version: object.version }
    : null;
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
      withGeneration(`${base}/${started.payload.id}/parts/1`, generationId),
      bytes,
      input.mimeType,
      bytes.byteLength,
      0,
    );
    expect(part.status).toBe(201);

    const completed = await worker.fetch(
      new Request(withGeneration(`${base}/${started.payload.id}/complete`, generationId), { method: "POST" }),
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
      withGeneration(`${base}/${started.payload.id}/parts/1`, generationId),
      PNG_BYTES,
      input.mimeType,
      PNG_BYTES.byteLength - 1,
    );
    expect(wrongSize.status).toBe(400);
    const wrongSignature = await putPart(
      withGeneration(`${base}/${started.payload.id}/parts/1`, generationId),
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
      withGeneration(`${base}/${sizeMismatchStarted.payload.id}/parts/1`, generationId),
      oversizedBody,
      sizeMismatchInput.mimeType,
      sizeMismatchInput.sizeBytes,
      0,
    );
    expect(acceptedStream.status).toBe(201);
    const rejectedObject = await worker.fetch(
      new Request(
        withGeneration(`${base}/${sizeMismatchStarted.payload.id}/complete`, generationId),
        { method: "POST" },
      ),
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
      withGeneration(`${uploadUrl}/parts/3`, generationId),
      QUICKTIME_BYTES,
      input.mimeType,
    );
    expect(outOfBounds.status).toBe(400);

    const outOfOrder = await putPart(
      withGeneration(`${uploadUrl}/parts/2`, generationId),
      QUICKTIME_BYTES,
      input.mimeType,
    );
    expect(outOfOrder.status).toBe(409);

    const firstPart = new Uint8Array(MULTIPART_PART_BYTES);
    firstPart.set(QUICKTIME_BYTES);
    const uploadedFirst = await putPart(
      withGeneration(`${uploadUrl}/parts/1`, generationId),
      firstPart,
      input.mimeType,
    );
    expect(uploadedFirst.status).toBe(201);

    const incomplete = await worker.fetch(
      new Request(withGeneration(`${uploadUrl}/complete`, generationId), { method: "POST" }),
    );
    expect(incomplete.status).toBe(409);

    const resumed = await startMediaUpload(base, input);
    expect(resumed.payload).toMatchObject({
      id: started.payload.id,
      disposition: "uploading",
      uploadedParts: [1],
    });

    const uploadedLast = await putPart(
      withGeneration(`${uploadUrl}/parts/2`, generationId),
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
      new Request(withGeneration(`${uploadUrl}/complete`, generationId), { method: "POST" }),
    );
    expect(invalidEtag.status).toBe(409);
    await env.DB.prepare(`
      UPDATE media_upload_parts SET etag = ?2 WHERE media_id = ?1 AND part_number = 2
    `).bind(started.payload.id, storedPart.etag).run();
    const completed = await worker.fetch(
      new Request(withGeneration(`${uploadUrl}/complete`, generationId), { method: "POST" }),
    );
    expect(completed.status).toBe(201);
    const completedAgain = await worker.fetch(
      new Request(withGeneration(`${uploadUrl}/complete`, generationId), { method: "POST" }),
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

    const aborted = await worker.fetch(
      new Request(withGeneration(`${uploadUrl}/abort`, generationId), { method: "POST" }),
    );
    expect(aborted.status).toBe(204);
    const closed = await putPart(
      withGeneration(`${uploadUrl}/parts/1`, generationId),
      PNG_BYTES,
      input.mimeType,
    );
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
    const partUrl = withGeneration(`${base}/${left.payload.id}/parts/1`, generationId);

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
      withGeneration(`${base}/${started.payload.id}/parts/1`, generationId),
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
      withGeneration(`${base}/${started.payload.id}/parts/1`, generationId),
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
    expect((await putPart(
      withGeneration(`${uploadUrl}/parts/1`, generationId),
      PNG_BYTES,
      input.mimeType,
    )).status).toBe(201);
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
      new Request(withGeneration(`${uploadUrl}/complete`, generationId), { method: "POST" }),
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
    expect((await putPart(
      withGeneration(`${uploadUrl}/parts/1`, generationId),
      PNG_BYTES,
      input.mimeType,
    )).status).toBe(201);
    await env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'completing', state_expires_at = ?2, version = version + 1
      WHERE media_id = ?1 AND status = 'uploading'
    `).bind(
      started.payload.id,
      new Date(Date.now() - 60_000).toISOString(),
    ).run();

    const recovered = await worker.fetch(
      new Request(withGeneration(`${uploadUrl}/complete`, generationId), { method: "POST" }),
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
    expect((await putPart(
      withGeneration(`${uploadUrl}/parts/1`, generationId),
      PNG_BYTES,
      input.mimeType,
    )).status).toBe(201);

    const [completed, aborted] = await Promise.all([
      worker.fetch(new Request(
        withGeneration(`${uploadUrl}/complete`, generationId),
        { method: "POST" },
      )),
      worker.fetch(new Request(
        withGeneration(`${uploadUrl}/abort`, generationId),
        { method: "POST" },
      )),
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

    const abortAgain = await worker.fetch(
      new Request(withGeneration(`${uploadUrl}/abort`, generationId), { method: "POST" }),
    );
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

  it.each([
    { action: "part" as const, seed: 121 },
    { action: "complete" as const, seed: 122 },
    { action: "abort" as const, seed: 123 },
  ])("rejects a stale generation $action without changing its replacement upload", async ({
    action,
    seed,
  }) => {
    const { importId, entryId, generationId: staleGenerationId } =
      await createImportAndEntry(seed);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(seed + 2_000, PNG_BYTES, staleGenerationId);
    const original = await startMediaUpload(base, input);
    if (original.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const originalState = await readUploadState(original.payload.id);
    if (!originalState) throw new Error("Expected the original upload state");

    const currentGenerationId = await retryImportEntry(importId, seed);
    expect(currentGenerationId).not.toBe(staleGenerationId);
    const replacement = await startMediaUpload(base, {
      ...input,
      generationId: currentGenerationId,
    });
    expect(replacement.response.status).toBe(201);
    expect(replacement.payload).toMatchObject({
      id: original.payload.id,
      disposition: "uploading",
      uploadedParts: [],
    });
    const replacementState = await readUploadState(original.payload.id);
    if (!replacementState) throw new Error("Expected the replacement upload state");
    expect(replacementState).toMatchObject({
      entry_generation_id: currentGenerationId,
      status: "uploading",
      next_part: 1,
    });
    expect(replacementState.upload_id).not.toBe(originalState.upload_id);
    expect(await env.MEDIA.head(replacementState.r2_key)).toBeNull();

    const staleUrl = `${base}/${original.payload.id}`;
    const staleResponse = action === "part"
      ? await putPart(
          withGeneration(`${staleUrl}/parts/1`, staleGenerationId),
          PNG_BYTES,
          input.mimeType,
        )
      : await worker.fetch(new Request(
          withGeneration(`${staleUrl}/${action}`, staleGenerationId),
          { method: "POST" },
        ));
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: { code: "ENTRY_IMPORT_GENERATION_CHANGED" },
    });
    expect(await readUploadState(original.payload.id)).toEqual(replacementState);
    expect(await env.MEDIA.head(replacementState.r2_key)).toBeNull();

    const currentUploadUrl = `${base}/${original.payload.id}`;
    expect((await putPart(
      withGeneration(`${currentUploadUrl}/parts/1`, currentGenerationId),
      PNG_BYTES,
      input.mimeType,
    )).status).toBe(201);
    expect((await worker.fetch(new Request(
      withGeneration(`${currentUploadUrl}/complete`, currentGenerationId),
      { method: "POST" },
    ))).status).toBe(201);
    expect(await readUploadState(original.payload.id)).toMatchObject({
      upload_id: replacementState.upload_id,
      entry_generation_id: currentGenerationId,
      status: "completed",
    });
    expect((await env.MEDIA.head(replacementState.r2_key))?.size).toBe(PNG_BYTES.byteLength);
    expect(
      (await worker.fetch(new Request(`http://localhost/api/entries/${entryId}`))).status,
    ).toBe(200);
  });

  it.each([
    { action: "part" as const, seed: 131, claimedStatus: "part_uploading" },
    { action: "complete" as const, seed: 132, claimedStatus: "completing" },
    { action: "complete-failure" as const, seed: 133, claimedStatus: "completing" },
    { action: "abort" as const, seed: 134, claimedStatus: "aborting" },
  ])("fences a deferred post-R2 $action transition from generation replacement", async ({
    action,
    seed,
    claimedStatus,
  }) => {
    const { importId, entryId, generationId: staleGenerationId } =
      await createImportAndEntry(seed);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(seed + 3_000, PNG_BYTES, staleGenerationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;
    if (action === "complete" || action === "complete-failure") {
      expect((await putPart(
        withGeneration(`${uploadUrl}/parts/1`, staleGenerationId),
        PNG_BYTES,
        input.mimeType,
      )).status).toBe(201);
    }

    const gate = deferredMultipartGate(action);
    const request = action === "part"
      ? new Request(withGeneration(`${uploadUrl}/parts/1`, staleGenerationId), {
          method: "PUT",
          headers: {
            "Content-Type": input.mimeType,
            "X-Media-Size": String(PNG_BYTES.byteLength),
          },
          body: PNG_BYTES,
        })
      : new Request(
          withGeneration(
            `${uploadUrl}/${action === "complete-failure" ? "complete" : action}`,
            staleGenerationId,
          ),
          { method: "POST" },
        );
    const pendingResponse = fetchWithMedia(request, gate.bucket);
    await gate.reached;

    let setupError: unknown;
    let currentGenerationId = "";
    let replacementState: Awaited<ReturnType<typeof readRaceState>> | null = null;
    let replacementObject: Awaited<ReturnType<typeof readObjectState>> = null;
    try {
      expect(await readUploadState(started.payload.id)).toMatchObject({
        entry_generation_id: staleGenerationId,
        status: claimedStatus,
      });
      currentGenerationId = await retryImportEntry(importId, seed);
      expect(currentGenerationId).not.toBe(staleGenerationId);
      const replacement = await replaceClaimedUpload(
        started.payload.id,
        currentGenerationId,
        input.mimeType,
      );
      replacementState = await readRaceState(started.payload.id, importId, input.sourcePath);
      replacementObject = await readObjectState(replacement.r2_key);
    } catch (error) {
      setupError = error;
    } finally {
      gate.release();
    }

    const staleResponse = await pendingResponse;
    if (setupError instanceof Error) throw setupError;
    if (setupError !== undefined) {
      throw new Error("Deferred R2 race setup failed", { cause: setupError });
    }
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      error: { code: "ENTRY_IMPORT_GENERATION_CHANGED" },
    });
    expect(await readRaceState(started.payload.id, importId, input.sourcePath))
      .toEqual(replacementState);
    const current = await readUploadState(started.payload.id);
    if (!current) throw new Error("Expected the replacement upload to remain active");
    expect(await readObjectState(current.r2_key)).toEqual(replacementObject);

    expect((await putPart(
      withGeneration(`${uploadUrl}/parts/1`, currentGenerationId),
      PNG_BYTES,
      input.mimeType,
    )).status).toBe(201);
    expect((await worker.fetch(new Request(
      withGeneration(`${uploadUrl}/complete`, currentGenerationId),
      { method: "POST" },
    ))).status).toBe(201);
    expect(await readUploadState(started.payload.id)).toMatchObject({
      upload_id: current.upload_id,
      entry_generation_id: currentGenerationId,
      status: "completed",
    });
    expect((await env.MEDIA.head(current.r2_key))?.size).toBe(PNG_BYTES.byteLength);
    expect(
      (await worker.fetch(new Request(`http://localhost/api/entries/${entryId}`))).status,
    ).toBe(200);
  });

  it("cleanup reconciles an R2 completion left behind before its D1 commit", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(114);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(1_117, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const uploadUrl = `${base}/${started.payload.id}`;
    expect((await putPart(
      withGeneration(`${uploadUrl}/parts/1`, generationId),
      PNG_BYTES,
      input.mimeType,
    )).status).toBe(201);
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
    expect((await putPart(
      withGeneration(`${completedUrl}/parts/1`, completed.generationId),
      PNG_BYTES,
      completedInput.mimeType,
    )).status).toBe(201);
    expect((await worker.fetch(new Request(
      withGeneration(`${completedUrl}/complete`, completed.generationId),
      { method: "POST" },
    ))).status).toBe(201);
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

    expect(await cleanupQueuedMedia(env)).toMatchObject({ referenced: 1, failed: 0 });
    expect(await env.DB.prepare(`SELECT id FROM media WHERE id = ?1`).bind(mediaId).first()).not.toBeNull();
    expect(await env.MEDIA.head(r2Key)).not.toBeNull();
    expect(
      await env.DB.prepare(`SELECT media_id FROM media_cleanup_queue WHERE media_id = ?1`)
        .bind(mediaId)
        .first(),
    ).toBeNull();
  });

  it("durably removes an unreferenced object from a failed upload", async () => {
    const { importId, entryId, generationId } = await createImportAndEntry(135);
    const base = uploadBase(importId, entryId);
    const input = mediaInput(3_135, PNG_BYTES, generationId);
    const started = await startMediaUpload(base, input);
    if (started.payload.disposition !== "uploading") throw new Error("Expected an upload session");
    const upload = await readUploadState(started.payload.id);
    if (!upload) throw new Error("Expected upload state");
    await env.MEDIA.resumeMultipartUpload(upload.r2_key, upload.upload_id).abort();
    await env.MEDIA.put(upload.r2_key, PNG_BYTES, {
      httpMetadata: { contentType: input.mimeType },
    });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE media_uploads SET status = 'failed', version = version + 1, updated_at = ?2
        WHERE media_id = ?1 AND status = 'uploading'
      `).bind(started.payload.id, now),
      env.DB.prepare(`
        UPDATE media SET status = 'failed', updated_at = ?2 WHERE id = ?1
      `).bind(started.payload.id, now),
      env.DB.prepare(`
        INSERT OR REPLACE INTO media_cleanup_queue (media_id, r2_key, requested_at)
        VALUES (?1, ?2, ?3)
      `).bind(started.payload.id, upload.r2_key, now),
    ]);

    expect(await cleanupQueuedMedia(env)).toMatchObject({ failed: 0 });
    expect(
      await env.DB.prepare(`SELECT id FROM media WHERE id = ?1`)
        .bind(started.payload.id)
        .first(),
    ).toBeNull();
    expect(await env.MEDIA.head(upload.r2_key)).toBeNull();
    expect(
      await env.DB.prepare(`SELECT media_id FROM media_cleanup_queue WHERE media_id = ?1`)
        .bind(started.payload.id)
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
