import { Hono } from "hono";
import { z } from "zod";
import type {
  ImportAppleJournalMediaResponse,
  StartAppleJournalMediaUploadInput,
  StartAppleJournalMediaUploadResponse,
  UploadAppleJournalMediaPartResponse,
} from "../../shared/api";
import type { AuthVariables } from "../lib/auth/middleware";
import { apiError, noStore } from "../lib/http";
import { reconcileImportedEntryStatement } from "../lib/import-status";
import {
  MAX_MEDIA_BYTES,
  MAX_MULTIPART_PARTS,
  MULTIPART_PART_BYTES,
  mediaR2Key,
  mimeTypeMatchesMediaType,
  multipartPartCount,
  multipartPartSize,
  validatedMediaBody,
} from "../lib/media";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
export const PART_UPLOAD_LEASE_MS = 10 * 60 * 1_000;
export const UPLOAD_STATE_LEASE_MS = 10 * 60 * 1_000;
export const UPLOAD_BOOKKEEPING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const CLEANUP_BATCH_SIZE = 50;
// R2 returns an opaque ETag; keep the exact value for complete(), but reject
// empty, control-character, or unreasonably large values before persistence.
const ETAG_PATTERN = /^[\x21-\x7e]{1,256}$/;

const startUploadSchema = z.object({
  generationId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourcePath: z.string().trim().min(1).max(1_000),
  type: z.enum(["photo", "video", "audio", "drawing"]),
  mimeType: z.string().trim().toLowerCase().min(1).max(100),
  sizeBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  position: z.number().int().min(0).max(10_000),
  placement: z.enum(["inline", "grid", "cover"]),
  caption: z.string().max(500),
}) satisfies z.ZodType<StartAppleJournalMediaUploadInput>;

interface MediaRow {
  id: string;
  r2_key: string;
  owner_subject: string | null;
  status: string;
  type: StartAppleJournalMediaUploadInput["type"];
  mime_type: string;
  size_bytes: number;
}

interface UploadRow {
  media_id: string;
  import_id: string;
  entry_id: string;
  entry_generation_id: string;
  owner_subject: string;
  source_path: string;
  upload_id: string;
  r2_key: string;
  media_status: string;
  type: StartAppleJournalMediaUploadInput["type"];
  mime_type: string;
  size_bytes: number;
  part_size: number;
  part_count: number;
  position: number;
  placement: "inline" | "grid" | "cover";
  caption: string;
  status:
    | "uploading"
    | "part_uploading"
    | "completing"
    | "aborting"
    | "completed"
    | "failed"
    | "aborted";
  version: number;
  next_part: number;
  active_part: number | null;
  active_part_expires_at: string | null;
  state_expires_at: string | null;
  expires_at: string;
  updated_at: string;
  fingerprint: string;
}

interface PartRow {
  part_number: number;
  etag: string;
  size_bytes: number;
}

export const importMediaUploadRoutes = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

function ownerSubject(context: { get(key: "auth"): AuthVariables["auth"] }): string | null {
  const auth = context.get("auth");
  if (auth.mode === "session") return auth.subject;
  if (auth.mode === "local") return "local-development";
  return null;
}

async function readJson(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

function importItemStatement(
  database: D1Database,
  input: {
    importId: string;
    sourcePath: string;
    mediaId: string;
    checksum: string;
    status: "processing" | "completed" | "duplicate" | "failed";
    errorCode?: string | null;
    requiredUploadStatus?: "completed" | "failed" | "aborted";
    now: string;
  },
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO import_items (
      id, import_id, source_path, source_id, checksum, kind, status,
      error_code, created_at, updated_at
    )
    SELECT ?1, ?2, ?3, ?4, ?5, 'media', ?6, ?7, ?8, ?8
    WHERE ?9 IS NULL OR EXISTS (
      SELECT 1 FROM media_uploads WHERE media_id = ?4 AND status = ?9
    )
    ON CONFLICT(import_id, source_path) DO UPDATE SET
      source_id = excluded.source_id,
      checksum = excluded.checksum,
      kind = 'media',
      status = excluded.status,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(),
    input.importId,
    input.sourcePath,
    input.mediaId,
    input.checksum,
    input.status,
    input.errorCode ?? null,
    input.now,
    input.requiredUploadStatus ?? null,
  );
}

function uploadRowQuery(database: D1Database, mediaId: string): Promise<UploadRow | null> {
  return database.prepare(`
    SELECT
      media_uploads.media_id, media_uploads.import_id, media_uploads.entry_id,
      media_uploads.entry_generation_id,
      media_uploads.owner_subject, media_uploads.source_path, media_uploads.upload_id,
      media_uploads.part_size, media_uploads.part_count, media_uploads.position,
      media_uploads.placement, media_uploads.caption, media_uploads.status,
      media_uploads.version, media_uploads.next_part, media_uploads.active_part,
      media_uploads.active_part_expires_at, media_uploads.state_expires_at,
      media_uploads.expires_at, media_uploads.updated_at,
      media.r2_key, media.sha256 AS fingerprint, media.status AS media_status,
      media.type, media.mime_type, media.size_bytes
    FROM media_uploads
    JOIN media ON media.id = media_uploads.media_id
    WHERE media_uploads.media_id = ?1
  `).bind(mediaId).first<UploadRow>();
}

function expectedPartSize(upload: UploadRow, partNumber: number): number {
  return multipartPartSize(upload.size_bytes, partNumber, upload.part_size);
}

function uploadMatchesRoute(
  upload: UploadRow,
  input: { importId: string; entryId: string; owner: string; generationId?: string },
): boolean {
  return (
    upload.import_id === input.importId &&
    upload.entry_id === input.entryId &&
    upload.owner_subject === input.owner &&
    (input.generationId === undefined || upload.entry_generation_id === input.generationId)
  );
}

function importedMediaLinkStatement(
  database: D1Database,
  input: {
    entryId: string;
    generationId: string;
    mediaId: string;
    position: number;
    placement: "inline" | "grid" | "cover";
    caption: string;
  },
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO entry_media (
      entry_id, media_id, position, placement, caption, import_generation_id
    )
    SELECT ?1, ?3, ?4, ?5, ?6, ?2
    WHERE EXISTS (
      SELECT 1 FROM entries
      WHERE id = ?1 AND source = 'apple_journal' AND import_generation_id = ?2
    )
    ON CONFLICT(entry_id, media_id) DO UPDATE SET
      position = excluded.position,
      placement = excluded.placement,
      caption = excluded.caption,
      import_generation_id = excluded.import_generation_id
  `).bind(
    input.entryId,
    input.generationId,
    input.mediaId,
    input.position,
    input.placement,
    input.caption,
  );
}

async function finalizeUpload(
  database: D1Database,
  upload: UploadRow,
  fingerprint: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`
      UPDATE media_uploads SET
        status = 'completed', active_part = NULL, active_part_expires_at = NULL,
        state_expires_at = NULL, version = version + 1, updated_at = ?4
      WHERE media_id = ?1 AND owner_subject = ?2
        AND status = 'completing' AND version = ?3
    `).bind(upload.media_id, upload.owner_subject, upload.version, now),
    database.prepare(`
      UPDATE media SET status = 'ready', updated_at = ?2
      WHERE id = ?1 AND EXISTS (
        SELECT 1 FROM media_uploads
        WHERE media_id = ?1 AND status = 'completed'
      )
    `).bind(upload.media_id, now),
    importedMediaLinkStatement(database, {
      entryId: upload.entry_id,
      generationId: upload.entry_generation_id,
      mediaId: upload.media_id,
      position: upload.position,
      placement: upload.placement,
      caption: upload.caption,
    }),
    importItemStatement(database, {
      importId: upload.import_id,
      sourcePath: upload.source_path,
      mediaId: upload.media_id,
      checksum: fingerprint,
      status: "completed",
      requiredUploadStatus: "completed",
      now,
    }),
    reconcileImportedEntryStatement(database, upload.entry_id, upload.entry_generation_id, now),
  ]);

  const completed = await uploadRowQuery(database, upload.media_id);
  return completed?.status === "completed" && completed.media_status === "ready";
}

function uploadResponse(
  upload: UploadRow,
  uploadedParts: number[],
): StartAppleJournalMediaUploadResponse {
  return {
    id: upload.media_id,
    disposition: "uploading",
    partSize: upload.part_size,
    partCount: upload.part_count,
    uploadedParts,
  };
}

async function uploadedPartNumbers(database: D1Database, mediaId: string): Promise<number[]> {
  const parts = await database.prepare(`
    SELECT part_number FROM media_upload_parts WHERE media_id = ?1 ORDER BY part_number
  `).bind(mediaId).all<{ part_number: number }>();
  return parts.results.map((part) => part.part_number);
}

importMediaUploadRoutes.post(
  "/imports/apple-journal/:importId/entries/:entryId/media/uploads",
  async (context) => {
    const parsed = startUploadSchema.safeParse(await readJson(context));
    if (!parsed.success) {
      return apiError(context, 400, "INVALID_MEDIA_UPLOAD", "這個媒體的上傳資訊不完整。");
    }

    const owner = ownerSubject(context);
    if (!owner) return apiError(context, 403, "UPLOAD_NOT_ALLOWED", "沒有權限上傳這個媒體。");

    const input = parsed.data;
    if (input.sizeBytes > MAX_MEDIA_BYTES) {
      return apiError(context, 413, "MEDIA_TOO_LARGE", "這個媒體超過目前可接受的大小。");
    }
    if (!mimeTypeMatchesMediaType(input.type, input.mimeType)) {
      return apiError(context, 400, "MEDIA_TYPE_MISMATCH", "媒體內容與檔案類型不一致。");
    }

    const partCount = multipartPartCount(input.sizeBytes);
    if (partCount < 1 || partCount > MAX_MULTIPART_PARTS) {
      return apiError(context, 413, "MEDIA_TOO_LARGE", "這個媒體超過目前可接受的大小。");
    }

    const importId = context.req.param("importId");
    const entryId = context.req.param("entryId");
    const [importJob, entry, existing] = await Promise.all([
      context.env.DB.prepare(`SELECT id FROM imports WHERE id = ?1`)
        .bind(importId)
        .first<{ id: string }>(),
      context.env.DB.prepare(`
        SELECT id, import_generation_id FROM entries
        WHERE id = ?1 AND source = 'apple_journal'
      `).bind(entryId).first<{ id: string; import_generation_id: string | null }>(),
      context.env.DB.prepare(`
        SELECT id, r2_key, owner_subject, status, type, mime_type, size_bytes
        FROM media WHERE sha256 = ?1
      `).bind(input.fingerprint).first<MediaRow>(),
    ]);
    if (!importJob) return apiError(context, 404, "IMPORT_NOT_FOUND", "找不到這次匯入工作。");
    if (!entry) return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇匯入日記。");
    if (entry.import_generation_id !== input.generationId) {
      return apiError(context, 409, "ENTRY_IMPORT_GENERATION_CHANGED", "這篇日記已有更新的匯入工作，請重新開始。");
    }
    if (existing?.owner_subject && existing.owner_subject !== owner) {
      return apiError(context, 409, "MEDIA_FINGERPRINT_CONFLICT", "這個媒體識別碼已被其他資料使用。");
    }

    const now = new Date().toISOString();
    if (
      existing &&
      (existing.type !== input.type ||
        existing.mime_type !== input.mimeType ||
        existing.size_bytes !== input.sizeBytes)
    ) {
      return apiError(context, 409, "MEDIA_FINGERPRINT_CONFLICT", "這個媒體識別碼的內容不一致。");
    }

    if (existing?.status === "ready") {
      const storedObject = await context.env.MEDIA.head(existing.r2_key);
      if (storedObject?.size !== input.sizeBytes) {
        return apiError(context, 409, "MEDIA_OBJECT_MISSING", "既有媒體檔案不完整，請先修復儲存空間。");
      }
      await context.env.DB.batch([
        context.env.DB.prepare(`
          UPDATE media SET owner_subject = ?2, updated_at = ?3 WHERE id = ?1
        `).bind(existing.id, owner, now),
        importedMediaLinkStatement(context.env.DB, {
          entryId,
          generationId: input.generationId,
          mediaId: existing.id,
          position: input.position,
          placement: input.placement,
          caption: input.caption,
        }),
        importItemStatement(context.env.DB, {
          importId,
          sourcePath: input.sourcePath,
          mediaId: existing.id,
          checksum: input.fingerprint,
          status: "duplicate",
          now,
        }),
        reconcileImportedEntryStatement(context.env.DB, entryId, input.generationId, now),
      ]);
      const response: StartAppleJournalMediaUploadResponse = {
        id: existing.id,
        disposition: "duplicate",
      };
      noStore(context);
      return context.json(response);
    }

    let currentUpload: UploadRow | null = null;
    if (existing) {
      currentUpload = await uploadRowQuery(context.env.DB, existing.id);
      const storedObject = await context.env.MEDIA.head(existing.r2_key);
      if (storedObject?.size === input.sizeBytes) {
        if (currentUpload && currentUpload.status !== "completed") {
          const reserved = await context.env.DB.prepare(`
            UPDATE media_uploads SET
              status = 'completing', active_part = NULL, active_part_expires_at = NULL,
              state_expires_at = ?5, version = version + 1, updated_at = ?4
            WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
              AND (
                status IN ('uploading', 'completing')
                OR (status = 'part_uploading' AND active_part_expires_at <= ?4)
              )
          `).bind(
            existing.id,
            owner,
            currentUpload.version,
            now,
            new Date(Date.now() + UPLOAD_STATE_LEASE_MS).toISOString(),
          ).run();
          if (reserved.meta.changes === 1) {
            currentUpload = {
              ...currentUpload,
              status: "completing",
              active_part: null,
              active_part_expires_at: null,
              state_expires_at: new Date(Date.now() + UPLOAD_STATE_LEASE_MS).toISOString(),
              version: currentUpload.version + 1,
            };
          } else {
            currentUpload = await uploadRowQuery(context.env.DB, existing.id);
          }
        }

        if (currentUpload && currentUpload.status !== "completed") {
          const finalized = await finalizeUpload(context.env.DB, currentUpload, input.fingerprint);
          if (!finalized) {
            return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個上傳工作處理。");
          }
        }
        await context.env.DB.batch([
          context.env.DB.prepare(`
            UPDATE media SET owner_subject = ?2, status = 'ready', updated_at = ?3 WHERE id = ?1
          `).bind(existing.id, owner, now),
          importedMediaLinkStatement(context.env.DB, {
            entryId,
            generationId: input.generationId,
            mediaId: existing.id,
            position: input.position,
            placement: input.placement,
            caption: input.caption,
          }),
          importItemStatement(context.env.DB, {
            importId,
            sourcePath: input.sourcePath,
            mediaId: existing.id,
            checksum: input.fingerprint,
            status: "duplicate",
            now,
          }),
          reconcileImportedEntryStatement(context.env.DB, entryId, input.generationId, now),
        ]);
        const response: StartAppleJournalMediaUploadResponse = {
          id: existing.id,
          disposition: "duplicate",
        };
        noStore(context);
        return context.json(response);
      }

      if (
        currentUpload &&
        currentUpload.status !== "completed" &&
        currentUpload.status !== "failed" &&
        currentUpload.status !== "aborted" &&
        (!uploadMatchesRoute(currentUpload, { importId, entryId, owner }) ||
          currentUpload.source_path !== input.sourcePath)
      ) {
        return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "相同媒體正在另一篇日記中完成上傳。");
      }

      if (
        currentUpload &&
        uploadMatchesRoute(currentUpload, { importId, entryId, owner, generationId: input.generationId }) &&
        currentUpload.source_path === input.sourcePath &&
        (currentUpload.status === "uploading" || currentUpload.status === "part_uploading") &&
        Date.parse(currentUpload.expires_at) > Date.now()
      ) {
        const response = uploadResponse(
          currentUpload,
          await uploadedPartNumbers(context.env.DB, existing.id),
        );
        noStore(context);
        return context.json(response);
      }

      if (currentUpload?.status === "completing" || currentUpload?.status === "aborting") {
        return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個上傳工作處理。");
      }

      if (
        currentUpload &&
        currentUpload.status !== "completed" &&
        currentUpload.status !== "failed" &&
        currentUpload.status !== "aborted"
      ) {
        if (
          currentUpload.status === "part_uploading" &&
          currentUpload.active_part_expires_at !== null &&
          Date.parse(currentUpload.active_part_expires_at) > Date.now()
        ) {
          return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體分段仍在上傳，請稍後重試。");
        }
        const claimed = await context.env.DB.prepare(`
          UPDATE media_uploads SET
            status = 'aborting', active_part = NULL, active_part_expires_at = NULL,
            state_expires_at = ?5, version = version + 1, updated_at = ?4
          WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
            AND (
              status = 'uploading'
              OR (status = 'part_uploading' AND active_part_expires_at <= ?4)
            )
        `).bind(
          existing.id,
          owner,
          currentUpload.version,
          now,
          new Date(Date.now() + UPLOAD_STATE_LEASE_MS).toISOString(),
        ).run();
        if (claimed.meta.changes !== 1) {
          return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個上傳工作處理。");
        }
        await context.env.MEDIA
          .resumeMultipartUpload(currentUpload.r2_key, currentUpload.upload_id)
          .abort()
          .catch(() => undefined);
        await context.env.DB.prepare(`
          UPDATE media_uploads SET
            status = 'aborted', state_expires_at = NULL,
            version = version + 1, updated_at = ?4
          WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3 AND status = 'aborting'
        `).bind(existing.id, owner, currentUpload.version + 1, now).run();
        currentUpload = await uploadRowQuery(context.env.DB, existing.id);
      }
    }

    const mediaId = existing?.id ?? crypto.randomUUID();
    const r2Key = existing?.r2_key ?? mediaR2Key("imports", mediaId, input.sourcePath);
    const multipart = await context.env.MEDIA.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: input.mimeType },
    });
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();

    try {
      const statements: D1PreparedStatement[] = [];
      if (existing) {
        if (currentUpload) {
          statements.push(
            context.env.DB.prepare(`
              UPDATE media_uploads SET
                import_id = ?2, entry_id = ?3, owner_subject = ?4, source_path = ?5,
                entry_generation_id = ?15,
                upload_id = ?6, part_size = ?7, part_count = ?8, position = ?9,
                placement = ?10, caption = ?11, status = 'uploading',
                version = version + 1, next_part = 1, active_part = NULL,
                active_part_expires_at = NULL, state_expires_at = NULL, expires_at = ?12,
                created_at = ?13, updated_at = ?13
              WHERE media_id = ?1 AND version = ?14 AND status IN ('failed', 'aborted')
            `).bind(
              mediaId,
              importId,
              entryId,
              owner,
              input.sourcePath,
              multipart.uploadId,
              MULTIPART_PART_BYTES,
              partCount,
              input.position,
              input.placement,
              input.caption,
              expiresAt,
              now,
              currentUpload.version,
              input.generationId,
            ),
          );
        } else {
          statements.push(
            context.env.DB.prepare(`
              INSERT INTO media_uploads (
                media_id, import_id, entry_id, entry_generation_id, owner_subject, source_path, upload_id,
                part_size, part_count, position, placement, caption, status,
                expires_at, created_at, updated_at
              ) VALUES (
                ?1, ?2, ?3, ?14, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                'uploading', ?12, ?13, ?13
              )
            `).bind(
              mediaId,
              importId,
              entryId,
              owner,
              input.sourcePath,
              multipart.uploadId,
              MULTIPART_PART_BYTES,
              partCount,
              input.position,
              input.placement,
              input.caption,
              expiresAt,
              now,
              input.generationId,
            ),
          );
        }
        statements.push(
          context.env.DB.prepare(`
            DELETE FROM media_upload_parts
            WHERE media_id = ?1 AND EXISTS (
              SELECT 1 FROM media_uploads WHERE media_id = ?1 AND upload_id = ?2
            )
          `).bind(mediaId, multipart.uploadId),
          context.env.DB.prepare(`
            UPDATE media SET
              owner_subject = ?2, status = 'uploading', updated_at = ?3
            WHERE id = ?1 AND EXISTS (
              SELECT 1 FROM media_uploads WHERE media_id = ?1 AND upload_id = ?4
            )
          `).bind(mediaId, owner, now, multipart.uploadId),
        );
      } else {
        statements.push(
          context.env.DB.prepare(`
            INSERT INTO media (
              id, r2_key, storage_kind, sha256, type, mime_type, size_bytes,
              status, owner_subject, created_at, updated_at
            ) VALUES (?1, ?2, 'private_r2', ?3, ?4, ?5, ?6, 'uploading', ?7, ?8, ?8)
          `).bind(
            mediaId,
            r2Key,
            input.fingerprint,
            input.type,
            input.mimeType,
            input.sizeBytes,
            owner,
            now,
          ),
          context.env.DB.prepare(`
            INSERT INTO media_uploads (
              media_id, import_id, entry_id, entry_generation_id, owner_subject, source_path, upload_id,
              part_size, part_count, position, placement, caption, status,
              expires_at, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?14, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
              'uploading', ?12, ?13, ?13
            )
          `).bind(
            mediaId,
            importId,
            entryId,
            owner,
            input.sourcePath,
            multipart.uploadId,
            MULTIPART_PART_BYTES,
            partCount,
            input.position,
            input.placement,
            input.caption,
            expiresAt,
            now,
            input.generationId,
          ),
        );
      }
      statements.push(
        importItemStatement(context.env.DB, {
          importId,
          sourcePath: input.sourcePath,
          mediaId,
          checksum: input.fingerprint,
          status: "processing",
          now,
        }),
      );
      const results = await context.env.DB.batch(statements);
      if (results[0]?.meta.changes !== 1) {
        await multipart.abort().catch(() => undefined);
        const winner = await uploadRowQuery(context.env.DB, mediaId);
        if (
          winner &&
          uploadMatchesRoute(winner, { importId, entryId, owner, generationId: input.generationId }) &&
          winner.source_path === input.sourcePath &&
          (winner.status === "uploading" || winner.status === "part_uploading")
        ) {
          const response = uploadResponse(
            winner,
            await uploadedPartNumbers(context.env.DB, mediaId),
          );
          noStore(context);
          return context.json(response);
        }
        return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個上傳工作處理。");
      }
    } catch {
      await multipart.abort().catch(() => undefined);
      const winnerMedia = await context.env.DB.prepare(`
        SELECT id FROM media WHERE sha256 = ?1
      `).bind(input.fingerprint).first<{ id: string }>();
      const winner = winnerMedia
        ? await uploadRowQuery(context.env.DB, winnerMedia.id)
        : null;
      if (
        winner &&
        uploadMatchesRoute(winner, { importId, entryId, owner, generationId: input.generationId }) &&
        winner.source_path === input.sourcePath &&
        (winner.status === "uploading" || winner.status === "part_uploading")
      ) {
        const response = uploadResponse(
          winner,
          await uploadedPartNumbers(context.env.DB, winner.media_id),
        );
        noStore(context);
        return context.json(response);
      }
      return apiError(context, 500, "MEDIA_UPLOAD_START_FAILED", "媒體上傳工作建立失敗，可以重試。");
    }

    const response: StartAppleJournalMediaUploadResponse = {
      id: mediaId,
      disposition: "uploading",
      partSize: MULTIPART_PART_BYTES,
      partCount,
      uploadedParts: [],
    };
    noStore(context);
    return context.json(response, 201);
  },
);

export interface MediaUploadCleanupResult {
  scanned: number;
  aborted: number;
  finalized: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export async function cleanupExpiredMediaUploads(
  env: Env,
  now = new Date(),
): Promise<MediaUploadCleanupResult> {
  const nowIso = now.toISOString();
  const terminalCutoff = new Date(
    now.getTime() - UPLOAD_BOOKKEEPING_RETENTION_MS,
  ).toISOString();
  const candidates = await env.DB.prepare(`
    SELECT media_id
    FROM media_uploads
    WHERE
      (status NOT IN ('completed', 'failed', 'aborted') AND expires_at <= ?1)
      OR
      (status IN ('completed', 'failed', 'aborted') AND updated_at <= ?2)
    ORDER BY updated_at
    LIMIT ?3
  `).bind(nowIso, terminalCutoff, CLEANUP_BATCH_SIZE).all<{ media_id: string }>();
  const result: MediaUploadCleanupResult = {
    scanned: candidates.results.length,
    aborted: 0,
    finalized: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates.results) {
    try {
      const upload = await uploadRowQuery(env.DB, candidate.media_id);
      if (!upload) {
        result.skipped += 1;
        continue;
      }

      if (upload.status === "completed" || upload.status === "failed" || upload.status === "aborted") {
        await env.DB.prepare(`
          DELETE FROM media_uploads
          WHERE media_id = ?1 AND version = ?2
            AND status IN ('completed', 'failed', 'aborted')
            AND updated_at <= ?3
        `).bind(upload.media_id, upload.version, terminalCutoff).run();
        if (await uploadRowQuery(env.DB, upload.media_id)) result.skipped += 1;
        else result.deleted += 1;
        continue;
      }

      const partLeaseActive =
        upload.status === "part_uploading" &&
        upload.active_part_expires_at !== null &&
        Date.parse(upload.active_part_expires_at) > now.getTime();
      const stateLeaseActive =
        (upload.status === "completing" || upload.status === "aborting") &&
        upload.state_expires_at !== null &&
        Date.parse(upload.state_expires_at) > now.getTime();
      if (partLeaseActive || stateLeaseActive) {
        result.skipped += 1;
        continue;
      }

      if (upload.status === "completing") {
        const object = await env.MEDIA.head(upload.r2_key);
        if (object?.size === upload.size_bytes) {
          if (await finalizeUpload(env.DB, upload, upload.fingerprint)) result.finalized += 1;
          else result.skipped += 1;
          continue;
        }
      }

      const abortLease = new Date(now.getTime() + UPLOAD_STATE_LEASE_MS).toISOString();
      const claimed = await env.DB.prepare(`
        UPDATE media_uploads SET
          status = 'aborting', active_part = NULL, active_part_expires_at = NULL,
          state_expires_at = ?5, version = version + 1, updated_at = ?4
        WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
          AND expires_at <= ?4
          AND (
            status = 'uploading'
            OR (status = 'part_uploading' AND active_part_expires_at <= ?4)
            OR (status IN ('completing', 'aborting') AND state_expires_at <= ?4)
          )
      `).bind(upload.media_id, upload.owner_subject, upload.version, nowIso, abortLease).run();
      if (claimed.meta.changes !== 1) {
        result.skipped += 1;
        continue;
      }
      const abortVersion = upload.version + 1;
      await env.MEDIA
        .resumeMultipartUpload(upload.r2_key, upload.upload_id)
        .abort()
        .catch(() => undefined);

      const completedObject = await env.MEDIA.head(upload.r2_key);
      if (completedObject?.size === upload.size_bytes) {
        const completingLease = new Date(now.getTime() + UPLOAD_STATE_LEASE_MS).toISOString();
        const recovered = await env.DB.prepare(`
          UPDATE media_uploads SET
            status = 'completing', state_expires_at = ?5,
            version = version + 1, updated_at = ?4
          WHERE media_id = ?1 AND owner_subject = ?2
            AND version = ?3 AND status = 'aborting'
        `).bind(
          upload.media_id,
          upload.owner_subject,
          abortVersion,
          nowIso,
          completingLease,
        ).run();
        if (
          recovered.meta.changes === 1 &&
          await finalizeUpload(
            env.DB,
            {
              ...upload,
              status: "completing",
              state_expires_at: completingLease,
              version: abortVersion + 1,
            },
            upload.fingerprint,
          )
        ) {
          result.finalized += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const [terminal] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE media_uploads SET
            status = 'aborted', state_expires_at = NULL,
            version = version + 1, updated_at = ?4
          WHERE media_id = ?1 AND owner_subject = ?2
            AND version = ?3 AND status = 'aborting'
        `).bind(upload.media_id, upload.owner_subject, abortVersion, nowIso),
        env.DB.prepare(`
          UPDATE media SET status = 'failed', updated_at = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM media_uploads WHERE media_id = ?1 AND status = 'aborted'
          )
        `).bind(upload.media_id, nowIso),
        importItemStatement(env.DB, {
          importId: upload.import_id,
          sourcePath: upload.source_path,
          mediaId: upload.media_id,
          checksum: upload.fingerprint,
          status: "failed",
          errorCode: "UPLOAD_EXPIRED",
          requiredUploadStatus: "aborted",
          now: nowIso,
        }),
        reconcileImportedEntryStatement(
          env.DB,
          upload.entry_id,
          upload.entry_generation_id,
          nowIso,
        ),
      ]);
      if (terminal.meta.changes === 1) result.aborted += 1;
      else result.skipped += 1;
    } catch {
      result.failed += 1;
      console.error(JSON.stringify({
        event: "media_upload_cleanup_failed",
        mediaId: candidate.media_id,
      }));
    }
  }

  return result;
}

importMediaUploadRoutes.put(
  "/imports/apple-journal/:importId/entries/:entryId/media/uploads/:mediaId/parts/:partNumber",
  async (context) => {
    const owner = ownerSubject(context);
    if (!owner) return apiError(context, 403, "UPLOAD_NOT_ALLOWED", "沒有權限上傳這個媒體。");

    const importId = context.req.param("importId");
    const entryId = context.req.param("entryId");
    const mediaId = context.req.param("mediaId");
    const partNumber = Number(context.req.param("partNumber"));
    const upload = await uploadRowQuery(context.env.DB, mediaId);
    if (!upload || !uploadMatchesRoute(upload, { importId, entryId, owner })) {
      return apiError(context, 404, "MEDIA_UPLOAD_NOT_FOUND", "找不到這個媒體上傳工作。");
    }
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > upload.part_count ||
      partNumber > MAX_MULTIPART_PARTS
    ) {
      return apiError(context, 400, "INVALID_PART_NUMBER", "媒體分段編號不正確。");
    }
    if (Date.parse(upload.expires_at) <= Date.now()) {
      return apiError(context, 409, "MEDIA_UPLOAD_EXPIRED", "媒體上傳已過期，請重新開始。");
    }

    const parts = await context.env.DB.prepare(`
      SELECT part_number, etag, size_bytes
      FROM media_upload_parts WHERE media_id = ?1 ORDER BY part_number
    `).bind(mediaId).all<PartRow>();
    const alreadyUploaded = parts.results.find((part) => part.part_number === partNumber);
    if (alreadyUploaded) {
      const response: UploadAppleJournalMediaPartResponse = { partNumber };
      noStore(context);
      return context.json(response);
    }
    if (upload.media_status === "ready" || upload.status === "completed") {
      return apiError(context, 409, "MEDIA_UPLOAD_CLOSED", "這個媒體上傳工作已經結束。");
    }
    if (partNumber !== upload.next_part) {
      return apiError(context, 409, "MEDIA_PART_OUT_OF_ORDER", "媒體分段必須依序上傳。");
    }
    const now = new Date();
    const staleReservation =
      upload.status === "part_uploading" &&
      upload.active_part === partNumber &&
      upload.active_part_expires_at !== null &&
      Date.parse(upload.active_part_expires_at) <= now.getTime();
    if (upload.status !== "uploading" && !staleReservation) {
      return apiError(context, 409, "MEDIA_PART_BUSY", "這個媒體分段正在由另一個請求處理。");
    }

    const declaredSize = Number(context.req.header("X-Media-Size") ?? 0);
    const transportSize = Number(context.req.header("Content-Length") ?? 0);
    const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    const requiredSize = expectedPartSize(upload, partNumber);
    if (
      declaredSize !== requiredSize ||
      (transportSize > 0 && transportSize !== requiredSize) ||
      contentType !== upload.mime_type ||
      !context.req.raw.body
    ) {
      return apiError(context, 400, "INVALID_MEDIA_PART", "媒體分段的大小或格式不正確。");
    }

    let body: ReadableStream<Uint8Array> | null = context.req.raw.body;
    if (partNumber === 1) {
      body = await validatedMediaBody(body, upload.type, upload.mime_type);
      if (!body) {
        return apiError(context, 400, "MEDIA_SIGNATURE_MISMATCH", "媒體內容與檔案類型不一致。");
      }
    }

    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + PART_UPLOAD_LEASE_MS).toISOString();
    const reserved = await context.env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'part_uploading', active_part = ?4, active_part_expires_at = ?5,
        version = version + 1, updated_at = ?6
      WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3 AND next_part = ?4
        AND (
          status = 'uploading'
          OR (
            status = 'part_uploading' AND active_part = ?4
            AND active_part_expires_at <= ?6
          )
        )
    `).bind(mediaId, owner, upload.version, partNumber, leaseExpiresAt, nowIso).run();
    if (reserved.meta.changes !== 1) {
      await body.cancel().catch(() => undefined);
      const completedPart = await context.env.DB.prepare(`
        SELECT part_number FROM media_upload_parts
        WHERE media_id = ?1 AND part_number = ?2
      `).bind(mediaId, partNumber).first<{ part_number: number }>();
      if (completedPart) {
        const response: UploadAppleJournalMediaPartResponse = { partNumber };
        noStore(context);
        return context.json(response);
      }
      return apiError(context, 409, "MEDIA_PART_BUSY", "這個媒體分段正在由另一個請求處理。");
    }
    const reservationVersion = upload.version + 1;
    const releaseReservation = async (): Promise<void> => {
      await context.env.DB.prepare(`
        UPDATE media_uploads SET
          status = 'uploading', active_part = NULL, active_part_expires_at = NULL,
          version = version + 1, updated_at = ?4
        WHERE media_id = ?1 AND owner_subject = ?2
          AND version = ?3 AND status = 'part_uploading'
      `).bind(mediaId, owner, reservationVersion, new Date().toISOString()).run();
    };

    let part: R2UploadedPart;
    try {
      part = await context.env.MEDIA
        .resumeMultipartUpload(upload.r2_key, upload.upload_id)
        .uploadPart(partNumber, body);
    } catch {
      await releaseReservation();
      return apiError(context, 500, "MEDIA_PART_UPLOAD_FAILED", "媒體分段上傳失敗，可以稍後重試。");
    }
    if (!ETAG_PATTERN.test(part.etag)) {
      await releaseReservation();
      return apiError(context, 500, "INVALID_MEDIA_PART_ETAG", "媒體分段驗證失敗，可以稍後重試。");
    }

    try {
      const committedAt = new Date().toISOString();
      const results = await context.env.DB.batch([
        context.env.DB.prepare(`
          INSERT INTO media_upload_parts (
            media_id, part_number, etag, size_bytes, updated_at
          )
          SELECT ?1, ?2, ?3, ?4, ?6
          FROM media_uploads
          WHERE media_id = ?1 AND owner_subject = ?5 AND version = ?7
            AND status = 'part_uploading' AND active_part = ?2
          ON CONFLICT(media_id, part_number) DO UPDATE SET
            etag = excluded.etag,
            size_bytes = excluded.size_bytes,
            updated_at = excluded.updated_at
        `).bind(
          mediaId,
          partNumber,
          part.etag,
          requiredSize,
          owner,
          committedAt,
          reservationVersion,
        ),
        context.env.DB.prepare(`
          UPDATE media_uploads SET
            status = 'uploading', next_part = ?4, active_part = NULL,
            active_part_expires_at = NULL, version = version + 1, updated_at = ?5
          WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
            AND status = 'part_uploading' AND active_part = ?6
        `).bind(
          mediaId,
          owner,
          reservationVersion,
          partNumber + 1,
          committedAt,
          partNumber,
        ),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        await releaseReservation();
        return apiError(context, 409, "MEDIA_PART_STATE_CHANGED", "媒體分段狀態已更新，請重新續傳。");
      }
    } catch {
      await releaseReservation();
      return apiError(context, 500, "MEDIA_PART_COMMIT_FAILED", "媒體分段已收到，但狀態保存失敗，可以重試。");
    }

    const response: UploadAppleJournalMediaPartResponse = { partNumber };
    noStore(context);
    return context.json(response, 201);
  },
);

importMediaUploadRoutes.post(
  "/imports/apple-journal/:importId/entries/:entryId/media/uploads/:mediaId/complete",
  async (context) => {
    const owner = ownerSubject(context);
    if (!owner) return apiError(context, 403, "UPLOAD_NOT_ALLOWED", "沒有權限上傳這個媒體。");

    const importId = context.req.param("importId");
    const entryId = context.req.param("entryId");
    const mediaId = context.req.param("mediaId");
    let upload = await uploadRowQuery(context.env.DB, mediaId);
    if (!upload || !uploadMatchesRoute(upload, { importId, entryId, owner })) {
      return apiError(context, 404, "MEDIA_UPLOAD_NOT_FOUND", "找不到這個媒體上傳工作。");
    }
    if (upload.status === "completed" && upload.media_status === "ready") {
      const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
      noStore(context);
      return context.json(response);
    }
    if (upload.status === "aborted" || upload.status === "failed" || upload.status === "aborting") {
      return apiError(context, 409, "MEDIA_UPLOAD_CLOSED", "這個媒體上傳工作已經結束。");
    }

    const media = await context.env.DB.prepare(`SELECT sha256 FROM media WHERE id = ?1`)
      .bind(mediaId)
      .first<{ sha256: string }>();
    if (!media) return apiError(context, 404, "MEDIA_UPLOAD_NOT_FOUND", "找不到這個媒體上傳工作。");

    let storedObject = await context.env.MEDIA.head(upload.r2_key);
    if (upload.status === "completing") {
      if (storedObject?.size === upload.size_bytes) {
        const finalized = await finalizeUpload(context.env.DB, upload, media.sha256);
        if (finalized) {
          const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
          noStore(context);
          return context.json(response);
        }
      }
      const stateExpired =
        upload.state_expires_at !== null &&
        Date.parse(upload.state_expires_at) <= Date.now();
      if (!stateExpired) {
        return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在完成上傳，請稍後重試。");
      }
      const releasedAt = new Date().toISOString();
      const released = await context.env.DB.prepare(`
        UPDATE media_uploads SET
          status = 'uploading', state_expires_at = NULL,
          version = version + 1, updated_at = ?4
        WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
          AND status = 'completing' AND state_expires_at <= ?4
      `).bind(mediaId, owner, upload.version, releasedAt).run();
      if (released.meta.changes !== 1) {
        return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在完成上傳，請稍後重試。");
      }
      upload = {
        ...upload,
        status: "uploading",
        state_expires_at: null,
        version: upload.version + 1,
      };
    }
    if (upload.status !== "uploading") {
      return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個請求處理。");
    }
    const reservableUpload = upload;

    const parts = await context.env.DB.prepare(`
      SELECT part_number, etag, size_bytes
      FROM media_upload_parts WHERE media_id = ?1 ORDER BY part_number
    `).bind(mediaId).all<PartRow>();
    const completeParts = parts.results.every(
      (part, index) =>
        part.part_number === index + 1 &&
        part.size_bytes === expectedPartSize(reservableUpload, part.part_number) &&
        ETAG_PATTERN.test(part.etag),
    );
    if (
      parts.results.length !== reservableUpload.part_count ||
      !completeParts ||
      reservableUpload.next_part !== reservableUpload.part_count + 1
    ) {
      return apiError(context, 409, "MEDIA_UPLOAD_INCOMPLETE", "媒體尚未完整上傳，可以從中斷處繼續。");
    }

    const reservedAt = new Date().toISOString();
    const stateExpiresAt = new Date(Date.now() + UPLOAD_STATE_LEASE_MS).toISOString();
    const reserved = await context.env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'completing', state_expires_at = ?6,
        version = version + 1, updated_at = ?5
      WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
        AND status = 'uploading' AND next_part = ?4
    `).bind(
      mediaId,
      owner,
      reservableUpload.version,
      reservableUpload.part_count + 1,
      reservedAt,
      stateExpiresAt,
    ).run();
    if (reserved.meta.changes !== 1) {
      upload = await uploadRowQuery(context.env.DB, mediaId);
      if (upload?.status === "completed" && upload.media_status === "ready") {
        const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
        noStore(context);
        return context.json(response);
      }
      if (upload?.status === "completing") {
        storedObject = await context.env.MEDIA.head(upload.r2_key);
        if (storedObject?.size === upload.size_bytes) {
          const finalized = await finalizeUpload(context.env.DB, upload, media.sha256);
          if (finalized) {
            const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
            noStore(context);
            return context.json(response);
          }
        }
      }
      return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個請求完成上傳。");
    }
    upload = {
      ...reservableUpload,
      status: "completing",
      state_expires_at: stateExpiresAt,
      version: reservableUpload.version + 1,
    };

    let completedSizeMismatch = false;
    if (storedObject?.size !== upload.size_bytes) {
      try {
        const object = await context.env.MEDIA
          .resumeMultipartUpload(upload.r2_key, upload.upload_id)
          .complete(parts.results.map((part) => ({
            partNumber: part.part_number,
            etag: part.etag,
          })));
        if (object.size !== upload.size_bytes) {
          await context.env.MEDIA.delete(upload.r2_key);
          completedSizeMismatch = true;
          throw new Error("Completed multipart object has the wrong size");
        }
      } catch {
        // A retryable R2 failure is distinguished from an already-completed
        // object by the authoritative head check below.
      }
    }

    if (completedSizeMismatch) {
      const failedAt = new Date().toISOString();
      await context.env.DB.batch([
        context.env.DB.prepare(`
          UPDATE media_uploads SET
            status = 'failed', state_expires_at = NULL,
            version = version + 1, updated_at = ?4
          WHERE media_id = ?1 AND owner_subject = ?2
            AND version = ?3 AND status = 'completing'
        `).bind(mediaId, owner, upload.version, failedAt),
        context.env.DB.prepare(`
          UPDATE media SET status = 'failed', updated_at = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM media_uploads WHERE media_id = ?1 AND status = 'failed'
          )
        `).bind(mediaId, failedAt),
        importItemStatement(context.env.DB, {
          importId,
          sourcePath: upload.source_path,
          mediaId,
          checksum: media.sha256,
          status: "failed",
          errorCode: "MEDIA_SIZE_MISMATCH",
          requiredUploadStatus: "failed",
          now: failedAt,
        }),
      ]);
      return apiError(context, 500, "MEDIA_SIZE_MISMATCH", "媒體大小驗證失敗，請重新開始上傳。");
    }

    storedObject = await context.env.MEDIA.head(upload.r2_key);
    if (storedObject?.size !== upload.size_bytes) {
      await context.env.DB.prepare(`
        UPDATE media_uploads SET
          status = 'uploading', state_expires_at = NULL,
          version = version + 1, updated_at = ?4
        WHERE media_id = ?1 AND owner_subject = ?2
          AND version = ?3 AND status = 'completing'
      `).bind(mediaId, owner, upload.version, new Date().toISOString()).run();
      return apiError(context, 500, "MEDIA_UPLOAD_COMPLETE_FAILED", "媒體完成上傳失敗，可以稍後重試。");
    }

    const finalized = await finalizeUpload(context.env.DB, upload, media.sha256);
    if (!finalized) {
      return apiError(context, 500, "MEDIA_UPLOAD_FINALIZE_FAILED", "媒體已上傳，狀態尚未完成，可以重試。");
    }
    const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
    noStore(context);
    return context.json(response, 201);
  },
);

importMediaUploadRoutes.post(
  "/imports/apple-journal/:importId/entries/:entryId/media/uploads/:mediaId/abort",
  async (context) => {
    const owner = ownerSubject(context);
    if (!owner) return apiError(context, 403, "UPLOAD_NOT_ALLOWED", "沒有權限上傳這個媒體。");

    const importId = context.req.param("importId");
    const entryId = context.req.param("entryId");
    const mediaId = context.req.param("mediaId");
    const upload = await uploadRowQuery(context.env.DB, mediaId);
    if (!upload || !uploadMatchesRoute(upload, { importId, entryId, owner })) {
      return apiError(context, 404, "MEDIA_UPLOAD_NOT_FOUND", "找不到這個媒體上傳工作。");
    }
    if (upload.status === "completed" || upload.status === "aborted" || upload.status === "failed") {
      noStore(context);
      return context.body(null, 204);
    }

    const nowDate = new Date();
    const stalePart =
      upload.status === "part_uploading" &&
      upload.active_part_expires_at !== null &&
      Date.parse(upload.active_part_expires_at) <= nowDate.getTime();
    const staleAbort =
      upload.status === "aborting" &&
      upload.state_expires_at !== null &&
      Date.parse(upload.state_expires_at) <= nowDate.getTime();
    if (upload.status !== "uploading" && !stalePart && !staleAbort) {
      return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個請求處理，暫時不能取消。");
    }
    const claimedAt = nowDate.toISOString();
    const stateExpiresAt = new Date(nowDate.getTime() + UPLOAD_STATE_LEASE_MS).toISOString();
    const claimed = await context.env.DB.prepare(`
      UPDATE media_uploads SET
        status = 'aborting', active_part = NULL, active_part_expires_at = NULL,
        state_expires_at = ?5, version = version + 1, updated_at = ?4
      WHERE media_id = ?1 AND owner_subject = ?2 AND version = ?3
        AND (
          status = 'uploading'
          OR (status = 'part_uploading' AND active_part_expires_at <= ?4)
          OR (status = 'aborting' AND state_expires_at <= ?4)
        )
    `).bind(mediaId, owner, upload.version, claimedAt, stateExpiresAt).run();
    if (claimed.meta.changes !== 1) {
      const current = await uploadRowQuery(context.env.DB, mediaId);
      if (current?.status === "completed" || current?.status === "aborted" || current?.status === "failed") {
        noStore(context);
        return context.body(null, 204);
      }
      return apiError(context, 409, "MEDIA_UPLOAD_BUSY", "媒體正在由另一個請求處理，暫時不能取消。");
    }
    const abortVersion = upload.version + 1;

    await context.env.MEDIA
      .resumeMultipartUpload(upload.r2_key, upload.upload_id)
      .abort()
      .catch(() => undefined);
    const media = await context.env.DB.prepare(`SELECT sha256 FROM media WHERE id = ?1`)
      .bind(mediaId)
      .first<{ sha256: string }>();
    const completedObject = await context.env.MEDIA.head(upload.r2_key);
    if (media && completedObject?.size === upload.size_bytes) {
      const completingAt = new Date().toISOString();
      const completingExpiresAt = new Date(Date.now() + UPLOAD_STATE_LEASE_MS).toISOString();
      const recovered = await context.env.DB.prepare(`
        UPDATE media_uploads SET
          status = 'completing', state_expires_at = ?5,
          version = version + 1, updated_at = ?4
        WHERE media_id = ?1 AND owner_subject = ?2
          AND version = ?3 AND status = 'aborting'
      `).bind(mediaId, owner, abortVersion, completingAt, completingExpiresAt).run();
      if (recovered.meta.changes === 1) {
        await finalizeUpload(
          context.env.DB,
          {
            ...upload,
            status: "completing",
            state_expires_at: completingExpiresAt,
            version: abortVersion + 1,
          },
          media.sha256,
        );
      }
      noStore(context);
      return context.body(null, 204);
    }

    const now = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE media_uploads SET
          status = 'aborted', state_expires_at = NULL,
          version = version + 1, updated_at = ?4
        WHERE media_id = ?1 AND owner_subject = ?2
          AND version = ?3 AND status = 'aborting'
      `).bind(mediaId, owner, abortVersion, now),
      context.env.DB.prepare(`
        UPDATE media SET status = 'failed', updated_at = ?2
        WHERE id = ?1 AND EXISTS (
          SELECT 1 FROM media_uploads WHERE media_id = ?1 AND status = 'aborted'
        )
      `).bind(mediaId, now),
      importItemStatement(context.env.DB, {
        importId,
        sourcePath: upload.source_path,
        mediaId,
        checksum: media?.sha256 ?? "0".repeat(64),
        status: "failed",
        errorCode: "UPLOAD_ABORTED",
        requiredUploadStatus: "aborted",
        now,
      }),
      reconcileImportedEntryStatement(
        context.env.DB,
        entryId,
        upload.entry_generation_id,
        now,
      ),
    ]);
    noStore(context);
    return context.body(null, 204);
  },
);
