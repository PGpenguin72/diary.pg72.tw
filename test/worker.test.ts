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
});
