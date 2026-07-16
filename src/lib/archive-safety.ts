export class AppleJournalArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleJournalArchiveError";
  }
}

export function normalizeArchivePath(path: string): string {
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
