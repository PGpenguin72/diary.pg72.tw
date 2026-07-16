import type { MediaPreview, MediaType } from "../../shared/api";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_WORKER_UPLOAD_BYTES = 90 * 1024 * 1024;
export const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = 10_000;

/** One media row joined with its entry_media link, as read for API previews. */
export interface EntryMediaRow {
  id: string;
  entry_id: string;
  type: MediaType;
  r2_key: string;
  storage_kind: "private_r2" | "demo_asset";
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  alt_text: string;
  caption: string;
  placement: "inline" | "grid" | "cover";
}

export function mediaSource(media: Pick<EntryMediaRow, "storage_kind" | "r2_key" | "id">): string {
  return media.storage_kind === "demo_asset"
    ? `/${media.r2_key}`
    : `/api/media/${media.id}`;
}

export function mediaPreviewFromRow(row: EntryMediaRow): MediaPreview {
  return {
    id: row.id,
    type: row.type,
    src: mediaSource(row),
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    alt: row.alt_text,
    caption: row.caption,
    placement: row.placement,
  };
}

export interface ParsedMediaUpload {
  fingerprint: string;
  mimeType: string;
  sizeBytes: number;
  body: ReadableStream<Uint8Array>;
}

/**
 * Validates the shared upload header contract: `X-Media-Fingerprint` (sha256
 * hex), Content-Type, and Content-Length / `X-Media-Size`, with a streamed
 * request body bounded by MAX_MEDIA_BYTES. Returns null when invalid.
 */
export function parseMediaUpload(request: {
  header(name: string): string | undefined;
  raw: { body: ReadableStream<Uint8Array> | null };
}): ParsedMediaUpload | null {
  const fingerprint = request.header("X-Media-Fingerprint")?.toLowerCase();
  const mimeType = request.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredSize = Number(request.header("X-Media-Size") ?? 0);
  const transportSize = Number(request.header("Content-Length") ?? 0);
  const sizeBytes = declaredSize > 0 ? declaredSize : transportSize;

  if (
    !fingerprint?.match(/^[a-f0-9]{64}$/) ||
    !mimeType ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_WORKER_UPLOAD_BYTES ||
    (transportSize > 0 && transportSize !== sizeBytes) ||
    !request.raw.body
  ) {
    return null;
  }

  return { fingerprint, mimeType, sizeBytes, body: request.raw.body };
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function detectedMediaMimeType(bytes: Uint8Array, expectedType: MediaType): string | null {
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
    if (expectedType === "audio") return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    if (expectedType === "video") return "video/mp4";
  }

  return null;
}

export function mimeTypeMatchesMediaType(type: MediaType, mimeType: string): boolean {
  if (type === "photo" || type === "drawing") return mimeType.startsWith("image/");
  if (type === "video") return mimeType.startsWith("video/");
  return mimeType.startsWith("audio/");
}

async function readPrefix(stream: ReadableStream<Uint8Array>, byteCount: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const prefix = new Uint8Array(byteCount);
  let offset = 0;

  try {
    while (offset < byteCount) {
      const { done, value } = await reader.read();
      if (done) break;
      const length = Math.min(value.byteLength, byteCount - offset);
      prefix.set(value.subarray(0, length), offset);
      offset += length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return prefix.subarray(0, offset);
}

/**
 * Tees a streamed upload so only a short prefix is inspected in memory. The
 * returned branch still contains every byte and can be passed directly to R2.
 */
export async function validatedMediaBody(
  body: ReadableStream<Uint8Array>,
  type: MediaType,
  mimeType: string,
): Promise<ReadableStream<Uint8Array> | null> {
  if (!mimeTypeMatchesMediaType(type, mimeType)) return null;

  const [probe, upload] = body.tee();
  const detected = detectedMediaMimeType(await readPrefix(probe, 32), type);
  if (detected !== mimeType) {
    await upload.cancel().catch(() => undefined);
    return null;
  }
  return upload;
}

/** Derives the R2 key from the uploaded file name: `<prefix>/<mediaId>[.ext]`. */
export function mediaR2Key(prefix: string, mediaId: string, fileName: string): string {
  const extensionMatch = fileName.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return `${prefix}/${mediaId}${extensionMatch ? `.${extensionMatch[1]}` : ""}`;
}

export interface UploadMediaObjectOptions {
  db: D1Database;
  bucket: R2Bucket;
  mediaId: string;
  r2Key: string;
  fingerprint: string;
  type: MediaType;
  mimeType: string;
  sizeBytes: number;
  body: ReadableStream<Uint8Array>;
  ownerSubject: string;
  now: string;
  /** Batched atomically with the media row flipping to 'ready'. */
  successStatements?: D1PreparedStatement[];
  /** Batched atomically with the media row flipping to 'failed'. */
  failureStatements?: D1PreparedStatement[];
}

/**
 * Shared new-media write path: insert the media row as 'uploading', stream the
 * bytes to R2, then mark it 'ready' (or 'failed') together with the caller's
 * extra statements. Returns false when the R2 upload failed.
 */
export async function uploadMediaObject(options: UploadMediaObjectOptions): Promise<boolean> {
  await options.db
    .prepare(`
      INSERT INTO media (
        id, r2_key, storage_kind, sha256, type, mime_type, size_bytes,
        status, owner_subject, created_at, updated_at
      ) VALUES (?1, ?2, 'private_r2', ?3, ?4, ?5, ?6, 'uploading', ?7, ?8, ?8)
    `)
    .bind(
      options.mediaId,
      options.r2Key,
      options.fingerprint,
      options.type,
      options.mimeType,
      options.sizeBytes,
      options.ownerSubject,
      options.now,
    )
    .run();

  try {
    const object = await options.bucket.put(options.r2Key, options.body, {
      httpMetadata: { contentType: options.mimeType },
    });
    if (!object || object.size !== options.sizeBytes) {
      await options.bucket.delete(options.r2Key);
      throw new Error("Uploaded media size did not match its declaration");
    }
    await options.db.batch([
      options.db
        .prepare(`UPDATE media SET status = 'ready', updated_at = ?2 WHERE id = ?1`)
        .bind(options.mediaId, new Date().toISOString()),
      ...(options.successStatements ?? []),
    ]);
    return true;
  } catch {
    await options.db.batch([
      options.db
        .prepare(`UPDATE media SET status = 'failed', updated_at = ?2 WHERE id = ?1`)
        .bind(options.mediaId, new Date().toISOString()),
      ...(options.failureStatements ?? []),
    ]);
    return false;
  }
}
