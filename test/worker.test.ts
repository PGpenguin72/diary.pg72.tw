import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { cleanupQueuedMedia } from "../worker/routes/import-media-uploads";

describe("diary Worker API", () => {
  it("returns an empty overview after applying migrations", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/api/overview"),
    );
    const payload = await response.json<{
      stats: { totalEntries: number; totalWords: number };
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(payload.stats.totalEntries).toBe(0);
    expect(payload.stats.totalWords).toBe(0);
  });

  it("creates a local entry and returns it in the timeline", async () => {
    const createResponse = await exports.default.fetch(
      new Request("http://localhost/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "測試日記",
          body: "今天完成了第一個可以讀寫的版本。",
          occurredAt: "2026-07-15T04:00:00.000Z",
          timezone: "Asia/Taipei",
          localDate: "2026-07-15",
          location: "臺北",
          mood: "focused",
        }),
      }),
    );
    const created = await createResponse.json<{ id: string; status: string }>();

    expect(createResponse.status).toBe(201);
    expect(created.status).toBe("published");

    const timelineResponse = await exports.default.fetch(
      new Request("http://localhost/api/entries"),
    );
    const timeline = await timelineResponse.json<{
      entries: Array<{ id: string; title: string; location: string | null }>;
    }>();

    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({
      id: created.id,
      title: "測試日記",
      location: "臺北",
    });
  });

  it("rejects malformed entries without mutating D1", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "", body: "" }),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("denies remote writes without a PG72 ID session", async () => {
    const response = await exports.default.fetch(
      new Request("https://diary.pg72.tw/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("keeps remote reads public without a session", async () => {
    for (const path of ["/api/entries", "/api/overview"]) {
      const response = await exports.default.fetch(
        new Request(`https://diary.pg72.tw${path}`),
      );
      expect(response.status, path).toBe(200);
    }

    // Unknown media is a plain 404, not an auth challenge.
    const media = await exports.default.fetch(
      new Request("https://diary.pg72.tw/api/media/x"),
    );
    expect(media.status).toBe(404);
  });

  it("keeps the health check open on a remote hostname", async () => {
    const response = await exports.default.fetch(
      new Request("https://diary.pg72.tw/api/health"),
    );
    expect(response.status).toBe(200);
  });

  it("reports an unauthenticated remote session", async () => {
    const response = await exports.default.fetch(
      new Request("https://diary.pg72.tw/api/auth/session"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: false,
      canWrite: false,
      localBypass: false,
      user: null,
    });
  });

  it("imports Apple Journal entries and media idempotently on localhost", async () => {
    const fingerprint = "a".repeat(64);
    const startResponse = await exports.default.fetch(
      new Request("http://localhost/api/imports/apple-journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "AppleJournalEntries.zip",
          fileFingerprint: fingerprint,
          entryCount: 1,
          mediaCount: 1,
        }),
      }),
    );
    const importJob = await startResponse.json<{ id: string }>();
    expect(startResponse.status).toBe(201);

    const entryBody = JSON.stringify({
      sourcePath: "AppleJournalEntries/Entries/2024-11-03.html",
      mediaCount: 1,
      title: "合成匯入日記",
      body: "這是沒有私人資料的測試內容。",
      occurredAt: "2024-11-03T12:00:00.000Z",
      timezone: "Asia/Taipei",
      localDate: "2024-11-03",
      location: "測試地點",
      mood: null,
    });
    const entryResponse = await exports.default.fetch(
      new Request(`http://localhost/api/imports/apple-journal/${importJob.id}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: entryBody,
      }),
    );
    const imported = await entryResponse.json<{
      id: string;
      generationId: string;
      disposition: string;
    }>();
    expect(entryResponse.status).toBe(201);
    expect(imported.disposition).toBe("inserted");

    const hiddenWhileIncomplete = await exports.default.fetch(
      new Request(`http://localhost/api/entries/${imported.id}`),
    );
    expect(hiddenWhileIncomplete.status).toBe(404);

    const mediaFingerprint = "b".repeat(64);
    const mediaResponse = await exports.default.fetch(
      new Request(
        `http://localhost/api/imports/apple-journal/${importJob.id}/entries/${imported.id}/media?generationId=${encodeURIComponent(imported.generationId)}&sourcePath=AppleJournalEntries%2FResources%2Fphoto.png&type=photo&position=0&placement=cover&caption=`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "8",
            "X-Media-Fingerprint": mediaFingerprint,
          },
          body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        },
      ),
    );
    expect(mediaResponse.status).toBe(201);

    const visibleAfterMedia = await exports.default.fetch(
      new Request(`http://localhost/api/entries/${imported.id}`),
    );
    expect(visibleAfterMedia.status).toBe(200);

    const duplicateResponse = await exports.default.fetch(
      new Request(`http://localhost/api/imports/apple-journal/${importJob.id}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: entryBody,
      }),
    );
    const duplicate = await duplicateResponse.json<{
      id: string;
      generationId: string;
      disposition: string;
    }>();
    expect(duplicate.id).toBe(imported.id);
    expect(duplicate.disposition).toBe("duplicate");

    expect(
      (await exports.default.fetch(new Request(`http://localhost/api/entries/${imported.id}`))).status,
    ).toBe(404);
    const reusedMedia = await exports.default.fetch(
      new Request(
        `http://localhost/api/imports/apple-journal/${importJob.id}/entries/${imported.id}/media?generationId=${encodeURIComponent(duplicate.generationId)}&sourcePath=AppleJournalEntries%2FResources%2Fphoto.png&type=photo&position=0&placement=cover&caption=`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "8",
            "X-Media-Fingerprint": mediaFingerprint,
          },
          body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        },
      ),
    );
    expect(reusedMedia.status).toBe(200);

    const entryDetailResponse = await exports.default.fetch(
      new Request(`http://localhost/api/entries/${imported.id}`),
    );
    const entryDetail = await entryDetailResponse.json<{
      media: Array<{ src: string }>;
    }>();
    expect(entryDetail.media).toHaveLength(1);

    const storedMediaResponse = await exports.default.fetch(
      new Request(`http://localhost${entryDetail.media[0]?.src}`),
    );
    expect(storedMediaResponse.status).toBe(200);
    expect(new Uint8Array(await storedMediaResponse.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  it("keeps a changed re-import private until current-generation media reconciles", async () => {
    const startResponse = await exports.default.fetch(
      new Request("http://localhost/api/imports/apple-journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "SyntheticChangedImport.zip",
          fileFingerprint: "c".repeat(64),
          entryCount: 1,
          mediaCount: 1,
        }),
      }),
    );
    const importJob = await startResponse.json<{ id: string }>();
    const entryInput = {
      sourcePath: "Synthetic/Entries/changed.html",
      mediaCount: 1,
      title: "合成的第一版日記",
      body: "第一版合成內容。",
      occurredAt: "2026-07-17T00:00:00.000Z",
      timezone: "Asia/Taipei",
      localDate: "2026-07-17",
      location: null,
      mood: null,
    };
    const postEntry = async (input: typeof entryInput) => {
      const response = await exports.default.fetch(
        new Request(`http://localhost/api/imports/apple-journal/${importJob.id}/entries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      return {
        response,
        body: await response.json<{
          id: string;
          generationId: string;
          disposition: "inserted" | "updated" | "duplicate";
        }>(),
      };
    };
    const uploadMedia = (
      entryId: string,
      generationId: string,
      fingerprint: string,
      sourcePath: string,
      bytes: Uint8Array,
    ) => exports.default.fetch(
      new Request(
        `http://localhost/api/imports/apple-journal/${importJob.id}/entries/${entryId}/media?generationId=${encodeURIComponent(generationId)}&sourcePath=${encodeURIComponent(sourcePath)}&type=photo&position=0&placement=cover&caption=`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(bytes.byteLength),
            "X-Media-Fingerprint": fingerprint,
          },
          body: bytes,
        },
      ),
    );
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const first = await postEntry(entryInput);
    expect(first.response.status).toBe(201);
    const firstMediaResponse = await uploadMedia(
      first.body.id,
      first.body.generationId,
      "1".repeat(64),
      "Synthetic/Resources/old.png",
      png,
    );
    expect(firstMediaResponse.status).toBe(201);
    const firstMedia = await firstMediaResponse.json<{ id: string }>();
    const firstMediaRow = await env.DB.prepare(`SELECT r2_key FROM media WHERE id = ?1`)
      .bind(firstMedia.id)
      .first<{ r2_key: string }>();
    expect(
      (await exports.default.fetch(new Request(`http://localhost/api/entries/${first.body.id}`))).status,
    ).toBe(200);

    const changedInput = {
      ...entryInput,
      title: "合成的第二版日記",
      body: "第二版合成內容。",
    };
    const changed = await postEntry(changedInput);
    expect(changed.response.status).toBe(200);
    expect(changed.body.disposition).toBe("updated");
    expect(changed.body.generationId).not.toBe(first.body.generationId);
    expect(
      (await exports.default.fetch(new Request(`https://diary.pg72.tw/api/entries/${first.body.id}`))).status,
    ).toBe(404);
    const oldLink = await env.DB.prepare(`
      SELECT import_generation_id FROM entry_media WHERE entry_id = ?1
    `).bind(first.body.id).first<{ import_generation_id: string }>();
    expect(oldLink?.import_generation_id).toBe(first.body.generationId);

    const malformed = await uploadMedia(
      first.body.id,
      changed.body.generationId,
      "2".repeat(64),
      "Synthetic/Resources/new.png",
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    expect(malformed.status).toBe(400);
    expect(
      (await exports.default.fetch(new Request(`http://localhost/api/entries/${first.body.id}`))).status,
    ).toBe(404);

    const retry = await postEntry(changedInput);
    expect(retry.body.disposition).toBe("duplicate");
    expect(retry.body.generationId).not.toBe(changed.body.generationId);
    expect(
      (await uploadMedia(
        first.body.id,
        changed.body.generationId,
        "2".repeat(64),
        "Synthetic/Resources/new.png",
        png,
      )).status,
    ).toBe(409);
    expect(
      (await uploadMedia(
        first.body.id,
        retry.body.generationId,
        "2".repeat(64),
        "Synthetic/Resources/new.png",
        png,
      )).status,
    ).toBe(201);

    const visible = await exports.default.fetch(
      new Request(`https://diary.pg72.tw/api/entries/${first.body.id}`),
    );
    expect(visible.status).toBe(200);
    const detail = await visible.json<{ title: string; media: Array<{ id: string }> }>();
    expect(detail.title).toBe(changedInput.title);
    expect(detail.media).toHaveLength(1);
    const currentLinks = await env.DB.prepare(`
      SELECT import_generation_id FROM entry_media
      WHERE entry_id = ?1 AND import_generation_id = ?2
    `).bind(first.body.id, retry.body.generationId).all<{ import_generation_id: string }>();
    expect(currentLinks.results).toHaveLength(1);
    expect(
      await env.DB.prepare(`
        SELECT media_id FROM entry_media WHERE entry_id = ?1 AND media_id = ?2
      `).bind(first.body.id, firstMedia.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(`SELECT media_id FROM media_cleanup_queue WHERE media_id = ?1`)
        .bind(firstMedia.id)
        .first(),
    ).not.toBeNull();
    expect(await cleanupQueuedMedia(env)).toMatchObject({ deleted: 1, failed: 0 });
    expect(
      await env.DB.prepare(`SELECT id FROM media WHERE id = ?1`).bind(firstMedia.id).first(),
    ).toBeNull();
    expect(await env.MEDIA.head(firstMediaRow?.r2_key ?? "missing")).toBeNull();
  });
});
