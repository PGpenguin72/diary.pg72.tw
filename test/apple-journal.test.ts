import { describe, expect, it } from "vitest";
import {
  AppleJournalArchiveError,
  normalizeArchivePath,
} from "../src/lib/archive-safety";

describe("Apple Journal archive safety", () => {
  it.each([
    "../escape.html",
    "Entries/../../escape.html",
    "/absolute/entry.html",
    "C:/absolute/entry.html",
    "Entries/bad\0name.html",
  ])("rejects unsafe archive path %s", (path) => {
    expect(() => normalizeArchivePath(path)).toThrow(AppleJournalArchiveError);
  });

  it("normalizes platform separators without permitting traversal", () => {
    expect(normalizeArchivePath("./AppleJournalEntries\\Entries\\entry.html"))
      .toBe("AppleJournalEntries/Entries/entry.html");
  });
});
