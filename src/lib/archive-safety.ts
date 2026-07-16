export class AppleJournalArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleJournalArchiveError";
  }
}

export const MAX_ARCHIVE_PATH_BYTES = 1_024;
export const MAX_ARCHIVE_PATH_METADATA_BYTES = 8 * 1024 * 1024;
const textEncoder = new TextEncoder();

export function normalizeArchivePath(path: string): string {
  if (textEncoder.encode(path).byteLength > MAX_ARCHIVE_PATH_BYTES) {
    throw new AppleJournalArchiveError("ZIP 內有過長的檔案路徑。");
  }
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");

  if (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    parts.some((part) => part === ".." || part.includes("\0"))
  ) {
    throw new AppleJournalArchiveError("ZIP 內含不安全的檔案路徑。");
  }

  return parts.filter((part) => part && part !== ".").join("/");
}

export function addArchivePathMetadataBytes(totalBytes: number, path: string): number {
  const nextTotal = totalBytes + textEncoder.encode(path).byteLength;
  if (nextTotal > MAX_ARCHIVE_PATH_METADATA_BYTES) {
    throw new AppleJournalArchiveError("ZIP 中央目錄的檔案路徑總量異常。");
  }
  return nextTotal;
}
