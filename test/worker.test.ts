import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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

  it("does not allow writes on a remote hostname before Access verification is configured", async () => {
    const response = await exports.default.fetch(
      new Request("https://diary.pg72.tw/api/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(401);
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
    const imported = await entryResponse.json<{ id: string; disposition: string }>();
    expect(entryResponse.status).toBe(201);
    expect(imported.disposition).toBe("inserted");

    const mediaFingerprint = "b".repeat(64);
    const mediaResponse = await exports.default.fetch(
      new Request(
        `http://localhost/api/imports/apple-journal/${importJob.id}/entries/${imported.id}/media?sourcePath=AppleJournalEntries%2FResources%2Fphoto.png&type=photo&position=0&placement=cover&caption=`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "Content-Length": "4",
            "X-Media-Fingerprint": mediaFingerprint,
          },
          body: new Uint8Array([137, 80, 78, 71]),
        },
      ),
    );
    expect(mediaResponse.status).toBe(201);

    const duplicateResponse = await exports.default.fetch(
      new Request(`http://localhost/api/imports/apple-journal/${importJob.id}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: entryBody,
      }),
    );
    const duplicate = await duplicateResponse.json<{ id: string; disposition: string }>();
    expect(duplicate.id).toBe(imported.id);
    expect(duplicate.disposition).toBe("duplicate");

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
      new Uint8Array([137, 80, 78, 71]),
    );
  });
});
