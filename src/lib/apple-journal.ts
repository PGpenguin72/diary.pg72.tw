import {
  BlobReader,
  BlobWriter,
  TextWriter,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";

const MAX_ARCHIVE_FILES = 50_000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_HTML_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_HTML_BYTES = 250 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 500;

const mimeTypes: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  tiff: "image/tiff",
  tif: "image/tiff",
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  caf: "audio/x-caf",
};

export type AppleJournalMediaType = "photo" | "video" | "audio" | "drawing";

export interface AppleJournalMedia {
  sourcePath: string;
  archivePath: string;
  type: AppleJournalMediaType;
  mimeType: string;
  size: number;
  fingerprint: string;
  caption: string;
}

export interface ParsedAppleJournalEntry {
  sourcePath: string;
  title: string;
  body: string;
  occurredAt: string;
  timezone: string;
  localDate: string;
  location: string | null;
  mood: string | null;
  media: AppleJournalMedia[];
}

export interface AppleJournalArchivePreview {
  fileFingerprint: string;
  entries: ParsedAppleJournalEntry[];
  mediaCount: number;
  mediaBytes: number;
}

export interface AppleJournalMediaReader {
  read(media: AppleJournalMedia): Promise<Blob>;
  close(): Promise<void>;
}

export class AppleJournalArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleJournalArchiveError";
  }
}

function normalizeArchivePath(path: string): string {
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

function isPlatformMetadata(path: string): boolean {
  const parts = path.split("/");
  const fileName = parts.at(-1) ?? "";
  return parts[0]?.toLowerCase() === "__macosx" || fileName.startsWith("._") || fileName === ".DS_Store";
}

function resolveArchivePath(basePath: string, reference: string): string | null {
  const cleanReference = reference.split(/[?#]/, 1)[0]?.replaceAll("\\", "/").trim();
  if (!cleanReference || /^(?:data|https?|file):/i.test(cleanReference)) return null;

  const stack = basePath.split("/").slice(0, -1);
  for (const part of cleanReference.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    if (part.includes("\0")) return null;
    stack.push(part);
  }

  return stack.join("/");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function openArchive(file: File): Promise<{
  reader: ZipReader<Blob>;
  entries: Entry[];
  filesByPath: Map<string, FileEntry>;
}> {
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(signature[2] ?? -1)) {
    throw new AppleJournalArchiveError("檔案不是有效的 ZIP。");
  }

  const reader = new ZipReader(new BlobReader(file));

  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ARCHIVE_FILES) {
      throw new AppleJournalArchiveError("ZIP 內的檔案數量異常，已停止解壓縮。");
    }

    const totalUncompressedBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new AppleJournalArchiveError("ZIP 解壓後的總容量異常，已停止匯入。");
    }

    const filesByPath = new Map<string, FileEntry>();
    const lowerPaths = new Set<string>();
    for (const entry of entries) {
      const path = normalizeArchivePath(entry.filename);
      if (entry.encrypted) {
        throw new AppleJournalArchiveError("目前不支援有密碼的 Apple Journal ZIP。");
      }
      if (entry.unixMode && (entry.unixMode & 0o170000) === 0o120000) {
        throw new AppleJournalArchiveError("ZIP 內含不支援的 symbolic link。");
      }
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
      ) {
        throw new AppleJournalArchiveError("ZIP 內有檔案的壓縮比例異常。");
      }
      if (!entry.directory) {
        if (isPlatformMetadata(path)) continue;
        if (filesByPath.has(path) || lowerPaths.has(path.toLowerCase())) {
          throw new AppleJournalArchiveError("ZIP 內有重複且衝突的檔案路徑。");
        }
        filesByPath.set(path, entry);
        lowerPaths.add(path.toLowerCase());
      }
    }

    return { reader, entries, filesByPath };
  } catch (error) {
    await reader.close();
    throw error;
  }
}

function normalizedAssetType(item: Element): string {
  const className = Array.from(item.classList).find((value) => value.startsWith("assetType_"));
  return className?.slice("assetType_".length).replace(/[-_]/g, "").toLowerCase() ?? "";
}

function mediaType(assetType: string, path: string): AppleJournalMediaType | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = mimeTypes[extension] ?? "application/octet-stream";
  if (mimeType === "application/octet-stream") return null;

  if (assetType.includes("drawing") || assetType.includes("handwriting")) return "drawing";
  if (mimeType.startsWith("video/") || assetType.includes("video")) return "video";
  if (mimeType.startsWith("audio/") || assetType.includes("audio") || assetType.includes("recording")) {
    return "audio";
  }
  if (mimeType.startsWith("image/") && ["photo", "livephoto", "drawing"].includes(assetType)) {
    return "photo";
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

async function detectMediaMimeType(
  blob: Blob,
  expectedType: AppleJournalMediaType,
): Promise<string | null> {
  const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);

  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "caff") return "audio/x-caf";
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)) {
    return expectedType === "audio" ? "audio/mpeg" : null;
  }
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
    if (brand === "qt  ") return "video/quicktime";
    if (expectedType === "audio") return "audio/mp4";
    if (expectedType === "video") return "video/mp4";
  }

  return null;
}

function collectOverlayText(item: Element): string[] {
  const selectors = [
    ".gridItemOverlayHeader",
    ".gridItemOverlayFooter",
    ".gridItemOverlayText",
    ".activityType",
    ".activityMetrics",
    ".mediaTitle",
    ".mediaArtist",
    ".mediaCategory",
  ];
  const values = new Set<string>();

  for (const element of item.querySelectorAll(selectors.join(","))) {
    const value = element.textContent?.replace(/\s+/g, " ").trim();
    if (value) values.add(value);
  }

  return [...values];
}

function parseBody(document: Document): string {
  const sections: string[] = [];
  const prompt = document.querySelector(".reflectionPrompt")?.textContent?.replace(/\s+/g, " ").trim();
  if (prompt) sections.push(prompt);

  const candidates = document.querySelectorAll("p.p2, p.p3, blockquote, ol, ul");
  for (const element of candidates) {
    if (element.parentElement?.closest("blockquote, ol, ul")) continue;

    if (element.matches("ol, ul")) {
      const ordered = element.matches("ol");
      const items = Array.from(element.querySelectorAll(":scope > li"))
        .map((item, index) => {
          const text = item.textContent?.replace(/\s+/g, " ").trim();
          return text ? `${ordered ? `${index + 1}.` : "-"} ${text}` : "";
        })
        .filter(Boolean);
      if (items.length) sections.push(items.join("\n"));
      continue;
    }

    const text = element.textContent?.replace(/\s+/g, " ").trim();
    if (text) sections.push(element.matches("blockquote") ? `> ${text}` : text);
  }

  if (sections.length === (prompt ? 1 : 0)) {
    const fallback = document.querySelector(".bodyText")?.textContent?.replace(/\s+/g, " ").trim();
    if (fallback) sections.push(fallback);
  }

  return sections.filter((value, index, values) => value !== values[index - 1]).join("\n\n");
}

const monthNumbers: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseLocalDate(header: string, sourcePath: string): string | null {
  const chinese = header.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (chinese) return validDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]));

  const dayFirst = header.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dayFirst) {
    const month = monthNumbers[dayFirst[2]?.toLowerCase() ?? ""];
    if (month) return validDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = header.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthFirst) {
    const month = monthNumbers[monthFirst[1]?.toLowerCase() ?? ""];
    if (month) return validDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  const iso = `${header} ${sourcePath}`.match(/\b(20\d{2})[-_](\d{2})[-_](\d{2})\b/);
  return iso ? validDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
}

function titleFallback(localDate: string): string {
  const [, month = "", day = ""] = localDate.split("-");
  return `${Number(month)}月${Number(day)}日的日記`;
}

async function parseHtmlEntry(
  htmlEntry: FileEntry,
  sourcePath: string,
  filesByPath: Map<string, FileEntry>,
  filesByLowerPath: Map<string, FileEntry>,
  resourcesById: Map<string, string[]>,
): Promise<Omit<ParsedAppleJournalEntry, "media"> & { media: Omit<AppleJournalMedia, "fingerprint">[] }> {
  if (htmlEntry.uncompressedSize > MAX_HTML_ENTRY_BYTES) {
    throw new AppleJournalArchiveError("其中一篇日記的 HTML 大小異常。");
  }
  if (
    htmlEntry.compressedSize > 0 &&
    htmlEntry.uncompressedSize / htmlEntry.compressedSize > MAX_COMPRESSION_RATIO
  ) {
    throw new AppleJournalArchiveError("其中一篇日記的壓縮比例異常。");
  }

  const html = await htmlEntry.getData(new TextWriter());
  const document = new DOMParser().parseFromString(html, "text/html");
  const header = document.querySelector(".pageHeader")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const localDate = parseLocalDate(header, sourcePath);
  if (!localDate) {
    throw new AppleJournalArchiveError("其中一篇日記缺少可辨識的日期。");
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const title = document.querySelector(".title")?.textContent?.replace(/\s+/g, " ").trim() || titleFallback(localDate);
  const body = parseBody(document);
  const gridItems = Array.from(document.querySelectorAll(".assetGrid .gridItem"));
  const media: Omit<AppleJournalMedia, "fingerprint">[] = [];
  const seenMedia = new Set<string>();
  let location: string | null = null;
  let mood: string | null = null;

  for (const item of gridItems) {
    const assetType = normalizedAssetType(item);
    const overlay = collectOverlayText(item);
    if (!location && (assetType === "genericmap" || assetType === "multipinmap")) {
      location = overlay[0] ?? null;
    }
    if (!mood && assetType === "stateofmind") {
      mood = overlay.join(", ") || null;
    }

    const references = Array.from(item.querySelectorAll("img[src], video[src], video source[src], audio[src], audio source[src]"))
      .map((element) => element.getAttribute("src"))
      .filter((value): value is string => Boolean(value));
    const candidates = references
      .map((reference) => ({
        reference,
        resolved: resolveArchivePath(sourcePath, reference),
      }))
      .filter((candidate): candidate is { reference: string; resolved: string } => Boolean(candidate.resolved));
    const assetId = item.getAttribute("id")?.trim().toLowerCase();
    if (assetId) {
      for (const archivePath of resourcesById.get(assetId) ?? []) {
        candidates.push({ reference: archivePath, resolved: archivePath });
      }
    }

    for (const { reference, resolved } of candidates) {
      if (seenMedia.has(resolved)) continue;
      const archiveEntry = filesByPath.get(resolved) ?? filesByLowerPath.get(resolved.toLowerCase());
      if (!archiveEntry) continue;

      const type = mediaType(assetType, resolved);
      if (!type) continue;
      seenMedia.add(resolved);

      const extension = resolved.split(".").pop()?.toLowerCase() ?? "";
      media.push({
        sourcePath: reference,
        archivePath: normalizeArchivePath(archiveEntry.filename),
        type,
        mimeType: mimeTypes[extension] ?? "application/octet-stream",
        size: archiveEntry.uncompressedSize,
        caption: overlay.join(" · ").slice(0, 500),
      });
    }
  }

  return {
    sourcePath,
    title: title.slice(0, 180),
    body: body.slice(0, 100_000),
    occurredAt: `${localDate}T12:00:00.000Z`,
    timezone,
    localDate,
    location: location?.slice(0, 180) ?? null,
    mood: mood?.slice(0, 40) ?? null,
    media,
  };
}

export async function inspectAppleJournalArchive(file: File): Promise<AppleJournalArchivePreview> {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    throw new AppleJournalArchiveError("請選擇 AppleJournalEntries ZIP。");
  }
  if (file.size === 0) throw new AppleJournalArchiveError("這個 ZIP 沒有內容。");

  const { reader, entries, filesByPath } = await openArchive(file);
  try {
    const centralDirectoryFingerprint = entries
      .filter((entry) => !entry.directory)
      .map((entry) => `${normalizeArchivePath(entry.filename)}:${entry.uncompressedSize}:${entry.signature}`)
      .sort()
      .join("\n");
    const fileFingerprint = await sha256(`${file.size}\n${centralDirectoryFingerprint}`);
    const filesByLowerPath = new Map(
      [...filesByPath].map(([path, entry]) => [path.toLowerCase(), entry] as const),
    );
    const resourcesById = new Map<string, string[]>();
    for (const path of filesByPath.keys()) {
      if (!/(?:^|\/)Resources\/[^/]+$/i.test(path) || path.toLowerCase().endsWith(".json")) continue;
      const fileName = path.split("/").at(-1) ?? "";
      const id = fileName.replace(/\.[^.]+$/, "").toLowerCase();
      const current = resourcesById.get(id) ?? [];
      current.push(path);
      resourcesById.set(id, current);
    }
    const htmlEntries = [...filesByPath].filter(
      ([path]) => /(?:^|\/)Entries\/[^/]+\.html?$/i.test(path) && !/(?:^|\/)index\.html?$/i.test(path),
    );

    if (htmlEntries.length === 0) {
      throw new AppleJournalArchiveError("找不到 Apple Journal 的 Entries HTML 檔案。");
    }
    const totalHtmlBytes = htmlEntries.reduce((total, [, entry]) => total + entry.uncompressedSize, 0);
    if (totalHtmlBytes > MAX_TOTAL_HTML_BYTES) {
      throw new AppleJournalArchiveError("ZIP 內的日記文字大小異常，已停止解壓縮。");
    }

    const parsedEntries: ParsedAppleJournalEntry[] = [];
    for (const [sourcePath, htmlEntry] of htmlEntries) {
      const parsed = await parseHtmlEntry(
        htmlEntry,
        sourcePath,
        filesByPath,
        filesByLowerPath,
        resourcesById,
      );
      const media: AppleJournalMedia[] = [];
      for (const item of parsed.media) {
        const archiveEntry = filesByPath.get(item.archivePath) ?? filesByLowerPath.get(item.archivePath.toLowerCase());
        if (!archiveEntry) continue;
        media.push({
          ...item,
          fingerprint: await sha256(
            `${fileFingerprint}:${item.archivePath}:${archiveEntry.uncompressedSize}:${archiveEntry.signature}`,
          ),
        });
      }
      parsedEntries.push({ ...parsed, media });
    }

    parsedEntries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    const uniqueMedia = new Map<string, AppleJournalMedia>();
    for (const entry of parsedEntries) {
      for (const media of entry.media) uniqueMedia.set(media.fingerprint, media);
    }

    return {
      fileFingerprint,
      entries: parsedEntries,
      mediaCount: uniqueMedia.size,
      mediaBytes: [...uniqueMedia.values()].reduce((total, media) => total + media.size, 0),
    };
  } finally {
    await reader.close();
  }
}

export async function createAppleJournalMediaReader(file: File): Promise<AppleJournalMediaReader> {
  const { reader, filesByPath } = await openArchive(file);
  const filesByLowerPath = new Map(
    [...filesByPath].map(([path, entry]) => [path.toLowerCase(), entry] as const),
  );

  return {
    async read(media) {
      const entry = filesByPath.get(media.archivePath) ?? filesByLowerPath.get(media.archivePath.toLowerCase());
      if (!entry) throw new AppleJournalArchiveError("找不到其中一個日記媒體。");
      const blob = await entry.getData(new BlobWriter(media.mimeType));
      const detectedMimeType = await detectMediaMimeType(blob, media.type);
      if (!detectedMimeType) {
        throw new AppleJournalArchiveError("其中一個媒體的簽章與副檔名不一致。");
      }
      return blob.type === detectedMimeType ? blob : blob.slice(0, blob.size, detectedMimeType);
    },
    close: () => reader.close(),
  };
}
