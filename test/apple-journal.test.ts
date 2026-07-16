import { describe, expect, it } from "vitest";
import {
  addArchivePathMetadataBytes,
  AppleJournalArchiveError,
  MAX_ARCHIVE_PATH_BYTES,
  MAX_ARCHIVE_PATH_METADATA_BYTES,
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

  it("rejects one overlong central-directory path", () => {
    const path = `${"a".repeat(MAX_ARCHIVE_PATH_BYTES)}x`;
    expect(() => normalizeArchivePath(path)).toThrow("ZIP 內有過長的檔案路徑。");
  });

  it("rejects excessive aggregate central-directory path metadata", () => {
    expect(() => addArchivePathMetadataBytes(
      MAX_ARCHIVE_PATH_METADATA_BYTES - 2,
      "abc",
    )).toThrow("ZIP 中央目錄的檔案路徑總量異常。");
    expect(addArchivePathMetadataBytes(0, "Entries/entry.html")).toBe(18);
  });
});
