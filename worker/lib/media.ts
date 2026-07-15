import type { MediaPreview, MediaType } from "../../shared/api";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;

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
  body: ReadableStream;
}

/**
 * Validates the shared upload header contract: `X-Media-Fingerprint` (sha256
 * hex), Content-Type, and Content-Length / `X-Media-Size`, with a streamed
 * request body bounded by MAX_MEDIA_BYTES. Returns null when invalid.
 */
export function parseMediaUpload(request: {
  header(name: string): string | undefined;
  raw: Request;
}): ParsedMediaUpload | null {
  const fingerprint = request.header("X-Media-Fingerprint")?.toLowerCase();
  const mimeType = request.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const sizeBytes = Number(
    request.header("Content-Length") ?? request.header("X-Media-Size") ?? 0,
  );

  if (
    !fingerprint?.match(/^[a-f0-9]{64}$/) ||
    !mimeType ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_MEDIA_BYTES ||
    !request.raw.body
  ) {
    return null;
  }

  return { fingerprint, mimeType, sizeBytes, body: request.raw.body };
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
  body: ReadableStream;
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
        status, created_at, updated_at
      ) VALUES (?1, ?2, 'private_r2', ?3, ?4, ?5, ?6, 'uploading', ?7, ?7)
    `)
    .bind(
      options.mediaId,
      options.r2Key,
      options.fingerprint,
      options.type,
      options.mimeType,
      options.sizeBytes,
      options.now,
    )
    .run();

  try {
    await options.bucket.put(options.r2Key, options.body, {
      httpMetadata: { contentType: options.mimeType },
    });
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
