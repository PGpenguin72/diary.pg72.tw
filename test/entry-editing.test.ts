import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = exports.default;
const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

interface EntryDetailPayload {
  id: string;
  title: string;
  excerpt: string;
  occurredAt: string;
  localDate: string;
  location: string | null;
  mood: string | null;
  wordCount: number;
  media: Array<{ id: string; src: string; caption: string; placement: string }>;
  blocks: Array<{ type: string; text: string | null; position: number }>;
}

async function createEntry(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await worker.fetch(
    new Request("http://localhost/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "合成測試日記",
        body: "synthetic alpha content for tests",
        occurredAt: "2026-07-10T04:00:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-10",
        location: "臺北",
        mood: "calm",
        ...overrides,
      }),
    }),
  );
  expect(response.status).toBe(201);
  const created = await response.json<{ id: string }>();
  return created.id;
}

async function readDetail(entryId: string): Promise<Response> {
  return worker.fetch(new Request(`http://localhost/api/entries/${entryId}`));
}

async function patchEntry(entryId: string, body: string): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost/api/entries/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
}

function uploadMedia(
  entryId: string,
  options: { fingerprint: string; fileName?: string; bytes?: Uint8Array } = {
    fingerprint: "c".repeat(64),
  },
): Promise<Response> {
  const bytes = options.bytes ?? PNG_BYTES;
  const fileName = encodeURIComponent(options.fileName ?? "photo.png");
  return worker.fetch(
    new Request(
      `http://localhost/api/entries/${entryId}/media?sourcePath=${fileName}&type=photo&placement=grid&caption=`,
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.length),
          "X-Media-Fingerprint": options.fingerprint,
        },
        body: bytes,
      },
    ),
  );
}

async function searchEntryIds(term: string): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT entry_id FROM entry_search WHERE entry_search MATCH ?1`,
  )
    .bind(term)
    .all<{ entry_id: string }>();
  return result.results.map((row) => row.entry_id);
}

async function mediaR2Key(mediaId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT r2_key FROM media WHERE id = ?1`)
    .bind(mediaId)
    .first<{ r2_key: string }>();
  return row?.r2_key ?? null;
}

describe("entry editing API", () => {
  it("edits an entry, keeps media, and refreshes derived fields and search", async () => {
    const entryId = await createEntry();
    const uploadResponse = await uploadMedia(entryId, { fingerprint: "c".repeat(64) });
    expect(uploadResponse.status).toBe(201);

    const before = await (await readDetail(entryId)).json<EntryDetailPayload>();
    const patchResponse = await patchEntry(
      entryId,
      JSON.stringify({
        title: "改寫後的標題",
        body: "rewritten bravo words after editing",
        occurredAt: "2026-07-11T09:30:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-11",
        location: "高雄",
        mood: "happy",
      }),
    );
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toEqual({ id: entryId, status: "published" });

    const detailResponse = await readDetail(entryId);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json<EntryDetailPayload>();

    expect(detail.title).toBe("改寫後的標題");
    expect(detail.excerpt).toBe("rewritten bravo words after editing");
    expect(detail.occurredAt).toBe("2026-07-11T09:30:00.000Z");
    expect(detail.localDate).toBe("2026-07-11");
    expect(detail.location).toBe("高雄");
    expect(detail.mood).toBe("happy");
    expect(detail.wordCount).not.toBe(before.wordCount);

    // The body collapses to a single canonical paragraph; media stays linked.
    expect(detail.blocks).toHaveLength(1);
    expect(detail.blocks[0]).toMatchObject({
      type: "paragraph",
      text: "rewritten bravo words after editing",
    });
    expect(detail.media).toHaveLength(1);

    expect(await searchEntryIds("bravo")).toContain(entryId);
    expect(await searchEntryIds("alpha")).toHaveLength(0);
  });

  it("rejects invalid edits with stable error codes", async () => {
    const entryId = await createEntry();

    const invalidJson = await patchEntry(entryId, "{not json");
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: { code: "INVALID_JSON" } });

    const invalidEntry = await patchEntry(entryId, JSON.stringify({ title: "", body: "" }));
    expect(invalidEntry.status).toBe(400);
    expect(await invalidEntry.json()).toMatchObject({ error: { code: "INVALID_ENTRY" } });

    const oversized = await patchEntry(
      entryId,
      JSON.stringify({
        title: "太長",
        body: "a".repeat(130_000),
        occurredAt: "2026-07-11T09:30:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-11",
        location: null,
        mood: null,
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "ENTRY_TOO_LARGE" } });

    const missing = await patchEntry(
      crypto.randomUUID(),
      JSON.stringify({
        title: "無此日記",
        body: "missing entry",
        occurredAt: "2026-07-11T09:30:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-11",
        location: null,
        mood: null,
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "ENTRY_NOT_FOUND" } });
  });

  it("soft deletes an entry idempotently and hides it from list, detail, and search", async () => {
    const entryId = await createEntry({ body: "charlie words to disappear" });

    const deleteResponse = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryId}`, { method: "DELETE" }),
    );
    expect(deleteResponse.status).toBe(200);
    const deleted = await deleteResponse.json<{ id: string; deletedAt: string }>();
    expect(deleted.id).toBe(entryId);
    expect(deleted.deletedAt).toBeTruthy();

    const timeline = await (
      await worker.fetch(new Request("http://localhost/api/entries"))
    ).json<{ entries: Array<{ id: string }> }>();
    expect(timeline.entries.map((entry) => entry.id)).not.toContain(entryId);

    expect((await readDetail(entryId)).status).toBe(404);
    expect(await searchEntryIds("charlie")).toHaveLength(0);

    // Editing a soft-deleted entry is a 404, deleting again is idempotent.
    const editDeleted = await patchEntry(
      entryId,
      JSON.stringify({
        title: "不該成功",
        body: "should fail",
        occurredAt: "2026-07-11T09:30:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-11",
        location: null,
        mood: null,
      }),
    );
    expect(editDeleted.status).toBe(404);

    const repeatDelete = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryId}`, { method: "DELETE" }),
    );
    expect(repeatDelete.status).toBe(200);
    expect(await repeatDelete.json()).toEqual({ id: entryId, deletedAt: deleted.deletedAt });

    const missingDelete = await worker.fetch(
      new Request(`http://localhost/api/entries/${crypto.randomUUID()}`, { method: "DELETE" }),
    );
    expect(missingDelete.status).toBe(404);
  });

  it("restores a deleted entry and rebuilds its search row", async () => {
    const entryId = await createEntry({ body: "delta echo restorable words" });
    await worker.fetch(new Request(`http://localhost/api/entries/${entryId}`, { method: "DELETE" }));
    expect(await searchEntryIds("delta")).toHaveLength(0);

    const restoreResponse = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryId}/restore`, { method: "POST" }),
    );
    expect(restoreResponse.status).toBe(200);
    expect(await restoreResponse.json()).toEqual({ id: entryId, status: "published" });

    expect((await readDetail(entryId)).status).toBe(200);
    expect(await searchEntryIds("delta")).toContain(entryId);

    // Restoring again is an idempotent no-op rebuild.
    const repeatRestore = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryId}/restore`, { method: "POST" }),
    );
    expect(repeatRestore.status).toBe(200);
    expect(await searchEntryIds("delta")).toEqual([entryId]);

    const missingRestore = await worker.fetch(
      new Request(`http://localhost/api/entries/${crypto.randomUUID()}/restore`, {
        method: "POST",
      }),
    );
    expect(missingRestore.status).toBe(404);
  });

  it("uploads media to an entry, persists to R2, and dedupes by fingerprint", async () => {
    const entryId = await createEntry();
    const fingerprint = "d".repeat(64);

    const uploadResponse = await uploadMedia(entryId, { fingerprint });
    expect(uploadResponse.status).toBe(201);
    const uploaded = await uploadResponse.json<{
      media: { id: string; src: string; type: string; placement: string };
    }>();
    expect(uploaded.media.type).toBe("photo");
    expect(uploaded.media.src).toBe(`/api/media/${uploaded.media.id}`);

    const r2Key = await mediaR2Key(uploaded.media.id);
    expect(r2Key).toMatch(/^uploads\/.+\.png$/);
    const object = await env.MEDIA.get(r2Key ?? "");
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG_BYTES);

    const detail = await (await readDetail(entryId)).json<EntryDetailPayload>();
    expect(detail.media).toHaveLength(1);
    expect(detail.media[0]?.id).toBe(uploaded.media.id);

    // Re-uploading the same fingerprint to the same entry is idempotent.
    const repeatResponse = await uploadMedia(entryId, { fingerprint });
    expect(repeatResponse.status).toBe(200);
    const repeated = await repeatResponse.json<{ media: { id: string } }>();
    expect(repeated.media.id).toBe(uploaded.media.id);
    const detailAfterRepeat = await (await readDetail(entryId)).json<EntryDetailPayload>();
    expect(detailAfterRepeat.media).toHaveLength(1);

    // A second attachment appends after the existing one.
    const secondResponse = await uploadMedia(entryId, {
      fingerprint: "e".repeat(64),
      fileName: "second.png",
    });
    expect(secondResponse.status).toBe(201);
    const second = await secondResponse.json<{ media: { id: string } }>();
    const detailWithTwo = await (await readDetail(entryId)).json<EntryDetailPayload>();
    expect(detailWithTwo.media.map((media) => media.id)).toEqual([
      uploaded.media.id,
      second.media.id,
    ]);

    const invalidFingerprint = await worker.fetch(
      new Request(
        `http://localhost/api/entries/${entryId}/media?sourcePath=photo.png&type=photo&placement=grid&caption=`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(PNG_BYTES.length),
            "X-Media-Fingerprint": "not-a-sha256",
          },
          body: PNG_BYTES,
        },
      ),
    );
    expect(invalidFingerprint.status).toBe(400);

    const missingEntry = await uploadMedia(crypto.randomUUID(), {
      fingerprint: "f".repeat(64),
    });
    expect(missingEntry.status).toBe(404);
  });

  it("removes media links and only deletes unreferenced objects from R2", async () => {
    const fingerprint = "1".repeat(64);
    const entryA = await createEntry({ body: "entry a shares media" });
    const entryB = await createEntry({ body: "entry b shares media" });

    const uploadA = await (await uploadMedia(entryA, { fingerprint })).json<{
      media: { id: string };
    }>();
    const uploadBResponse = await uploadMedia(entryB, { fingerprint });
    expect(uploadBResponse.status).toBe(201);
    const uploadB = await uploadBResponse.json<{ media: { id: string } }>();
    expect(uploadB.media.id).toBe(uploadA.media.id);

    const mediaId = uploadA.media.id;
    const r2Key = await mediaR2Key(mediaId);
    expect(r2Key).not.toBeNull();

    // Removing from one entry keeps the shared deduplicated object and row.
    const removeA = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryA}/media/${mediaId}`, {
        method: "DELETE",
      }),
    );
    expect(removeA.status).toBe(200);
    expect(await removeA.json()).toEqual({ removed: true });

    const detailA = await (await readDetail(entryA)).json<EntryDetailPayload>();
    expect(detailA.media).toHaveLength(0);
    expect(await env.MEDIA.get(r2Key ?? "")).not.toBeNull();
    expect(await mediaR2Key(mediaId)).toBe(r2Key);

    // Removing the last reference deletes the media row and the R2 object.
    const removeB = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryB}/media/${mediaId}`, {
        method: "DELETE",
      }),
    );
    expect(removeB.status).toBe(200);
    expect(await env.MEDIA.get(r2Key ?? "")).toBeNull();
    expect(await mediaR2Key(mediaId)).toBeNull();

    const removeAgain = await worker.fetch(
      new Request(`http://localhost/api/entries/${entryB}/media/${mediaId}`, {
        method: "DELETE",
      }),
    );
    expect(removeAgain.status).toBe(404);
    expect(await removeAgain.json()).toMatchObject({ error: { code: "MEDIA_NOT_FOUND" } });
  });

  it("denies remote editing mutations without a PG72 ID session", async () => {
    const patchRemote = await worker.fetch(
      new Request("https://diary.pg72.tw/api/entries/some-entry", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(patchRemote.status).toBe(401);

    const deleteRemote = await worker.fetch(
      new Request("https://diary.pg72.tw/api/entries/some-entry", { method: "DELETE" }),
    );
    expect(deleteRemote.status).toBe(401);
  });
});
