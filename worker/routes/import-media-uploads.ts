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
import {
  MAX_MEDIA_BYTES,
  MAX_MULTIPART_PARTS,
  MULTIPART_PART_BYTES,
  mediaR2Key,
  mimeTypeMatchesMediaType,
  validatedMediaBody,
} from "../lib/media";

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
// R2 returns an opaque ETag; keep the exact value for complete(), but reject
// empty, control-character, or unreasonably large values before persistence.
const ETAG_PATTERN = /^[\x21-\x7e]{1,256}$/;

const startUploadSchema = z.object({
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
  status: "uploading" | "completing" | "completed" | "failed" | "aborted";
  expires_at: string;
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
    now: string;
  },
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO import_items (
      id, import_id, source_path, source_id, checksum, kind, status,
      error_code, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'media', ?6, ?7, ?8, ?8)
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
  );
}

function uploadRowQuery(database: D1Database, mediaId: string): Promise<UploadRow | null> {
  return database.prepare(`
    SELECT
      media_uploads.media_id, media_uploads.import_id, media_uploads.entry_id,
      media_uploads.owner_subject, media_uploads.source_path, media_uploads.upload_id,
      media_uploads.part_size, media_uploads.part_count, media_uploads.position,
      media_uploads.placement, media_uploads.caption, media_uploads.status,
      media_uploads.expires_at, media.r2_key, media.status AS media_status,
      media.type, media.mime_type, media.size_bytes
    FROM media_uploads
    JOIN media ON media.id = media_uploads.media_id
    WHERE media_uploads.media_id = ?1
  `).bind(mediaId).first<UploadRow>();
}

function expectedPartSize(upload: UploadRow, partNumber: number): number {
  if (partNumber < upload.part_count) return upload.part_size;
  return upload.size_bytes - upload.part_size * (upload.part_count - 1);
}

function uploadMatchesRoute(
  upload: UploadRow,
  input: { importId: string; entryId: string; owner: string },
): boolean {
  return (
    upload.import_id === input.importId &&
    upload.entry_id === input.entryId &&
    upload.owner_subject === input.owner
  );
}

async function finalizeUpload(
  database: D1Database,
  upload: UploadRow,
  fingerprint: string,
): Promise<void> {
  const now = new Date().toISOString();
  await database.batch([
    database.prepare(`
      UPDATE media SET status = 'ready', updated_at = ?2 WHERE id = ?1
    `).bind(upload.media_id, now),
    database.prepare(`
      INSERT OR IGNORE INTO entry_media (
        entry_id, media_id, position, placement, caption
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `).bind(
      upload.entry_id,
      upload.media_id,
      upload.position,
      upload.placement,
      upload.caption,
    ),
    importItemStatement(database, {
      importId: upload.import_id,
      sourcePath: upload.source_path,
      mediaId: upload.media_id,
      checksum: fingerprint,
      status: "completed",
      now,
    }),
    database.prepare(`
      UPDATE media_uploads SET status = 'completed', updated_at = ?2 WHERE media_id = ?1
    `).bind(upload.media_id, now),
  ]);
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

    const partCount = Math.ceil(input.sizeBytes / MULTIPART_PART_BYTES);
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
        SELECT id FROM entries WHERE id = ?1 AND source = 'apple_journal'
      `).bind(entryId).first<{ id: string }>(),
      context.env.DB.prepare(`
        SELECT id, r2_key, owner_subject, status, type, mime_type, size_bytes
        FROM media WHERE sha256 = ?1
      `).bind(input.fingerprint).first<MediaRow>(),
    ]);
    if (!importJob) return apiError(context, 404, "IMPORT_NOT_FOUND", "找不到這次匯入工作。");
    if (!entry) return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇匯入日記。");
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
      await context.env.DB.batch([
        context.env.DB.prepare(`
          UPDATE media SET owner_subject = ?2, updated_at = ?3 WHERE id = ?1
        `).bind(existing.id, owner, now),
        context.env.DB.prepare(`
          INSERT OR IGNORE INTO entry_media (
            entry_id, media_id, position, placement, caption
          ) VALUES (?1, ?2, ?3, ?4, ?5)
        `).bind(entryId, existing.id, input.position, input.placement, input.caption),
        importItemStatement(context.env.DB, {
          importId,
          sourcePath: input.sourcePath,
          mediaId: existing.id,
          checksum: input.fingerprint,
          status: "duplicate",
          now,
        }),
      ]);
      const response: StartAppleJournalMediaUploadResponse = {
        id: existing.id,
        disposition: "duplicate",
      };
      noStore(context);
      return context.json(response);
    }

    if (existing) {
      const storedObject = await context.env.MEDIA.head(existing.r2_key);
      if (storedObject?.size === input.sizeBytes) {
        await context.env.DB.batch([
          context.env.DB.prepare(`
            UPDATE media SET owner_subject = ?2, status = 'ready', updated_at = ?3 WHERE id = ?1
          `).bind(existing.id, owner, now),
          context.env.DB.prepare(`
            INSERT OR IGNORE INTO entry_media (
              entry_id, media_id, position, placement, caption
            ) VALUES (?1, ?2, ?3, ?4, ?5)
          `).bind(entryId, existing.id, input.position, input.placement, input.caption),
          importItemStatement(context.env.DB, {
            importId,
            sourcePath: input.sourcePath,
            mediaId: existing.id,
            checksum: input.fingerprint,
            status: "duplicate",
            now,
          }),
        ]);
        const response: StartAppleJournalMediaUploadResponse = {
          id: existing.id,
          disposition: "duplicate",
        };
        noStore(context);
        return context.json(response);
      }

      const currentUpload = await uploadRowQuery(context.env.DB, existing.id);
      if (
        currentUpload &&
        uploadMatchesRoute(currentUpload, { importId, entryId, owner }) &&
        currentUpload.source_path === input.sourcePath &&
        currentUpload.status === "uploading" &&
        Date.parse(currentUpload.expires_at) > Date.now()
      ) {
        const parts = await context.env.DB.prepare(`
          SELECT part_number FROM media_upload_parts WHERE media_id = ?1 ORDER BY part_number
        `).bind(existing.id).all<{ part_number: number }>();
        const response: StartAppleJournalMediaUploadResponse = {
          id: existing.id,
          disposition: "uploading",
          partSize: currentUpload.part_size,
          partCount: currentUpload.part_count,
          uploadedParts: parts.results.map((part) => part.part_number),
        };
        noStore(context);
        return context.json(response);
      }

      if (currentUpload && currentUpload.status !== "completed") {
        await context.env.MEDIA
          .resumeMultipartUpload(currentUpload.r2_key, currentUpload.upload_id)
          .abort()
          .catch(() => undefined);
      }
    }

    const mediaId = existing?.id ?? crypto.randomUUID();
    const r2Key = existing?.r2_key ?? mediaR2Key("imports", mediaId, input.sourcePath);
    const multipart = await context.env.MEDIA.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: input.mimeType },
    });
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();

    try {
      const statements: D1PreparedStatement[] = [
        context.env.DB.prepare(`DELETE FROM media_uploads WHERE media_id = ?1`).bind(mediaId),
      ];
      if (existing) {
        statements.unshift(
          context.env.DB.prepare(`
            UPDATE media SET
              owner_subject = ?2, status = 'uploading', updated_at = ?3
            WHERE id = ?1
          `).bind(mediaId, owner, now),
        );
      } else {
        statements.unshift(
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
        );
      }
      statements.push(
        context.env.DB.prepare(`
          INSERT INTO media_uploads (
            media_id, import_id, entry_id, owner_subject, source_path, upload_id,
            part_size, part_count, position, placement, caption, status,
            expires_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
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
        ),
        importItemStatement(context.env.DB, {
          importId,
          sourcePath: input.sourcePath,
          mediaId,
          checksum: input.fingerprint,
          status: "processing",
          now,
        }),
      );
      await context.env.DB.batch(statements);
    } catch (error) {
      await multipart.abort().catch(() => undefined);
      throw error;
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
    if (upload.status !== "uploading" || upload.media_status === "ready") {
      return apiError(context, 409, "MEDIA_UPLOAD_CLOSED", "這個媒體上傳工作已經結束。");
    }
    if (Date.parse(upload.expires_at) <= Date.now()) {
      await context.env.MEDIA
        .resumeMultipartUpload(upload.r2_key, upload.upload_id)
        .abort()
        .catch(() => undefined);
      const now = new Date().toISOString();
      await context.env.DB.batch([
        context.env.DB.prepare(`
          UPDATE media SET status = 'failed', updated_at = ?2 WHERE id = ?1
        `).bind(mediaId, now),
        context.env.DB.prepare(`
          UPDATE media_uploads SET status = 'failed', updated_at = ?2 WHERE media_id = ?1
        `).bind(mediaId, now),
      ]);
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
    const nextPart = (parts.results.at(-1)?.part_number ?? 0) + 1;
    if (partNumber !== nextPart) {
      return apiError(context, 409, "MEDIA_PART_OUT_OF_ORDER", "媒體分段必須依序上傳。");
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

    let part: R2UploadedPart;
    try {
      part = await context.env.MEDIA
        .resumeMultipartUpload(upload.r2_key, upload.upload_id)
        .uploadPart(partNumber, body);
    } catch {
      return apiError(context, 500, "MEDIA_PART_UPLOAD_FAILED", "媒體分段上傳失敗，可以稍後重試。");
    }
    if (!ETAG_PATTERN.test(part.etag)) {
      return apiError(context, 500, "INVALID_MEDIA_PART_ETAG", "媒體分段驗證失敗，可以稍後重試。");
    }

    await context.env.DB.prepare(`
      INSERT INTO media_upload_parts (media_id, part_number, etag, size_bytes, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(media_id, part_number) DO UPDATE SET
        etag = excluded.etag,
        size_bytes = excluded.size_bytes,
        updated_at = excluded.updated_at
    `).bind(mediaId, partNumber, part.etag, requiredSize, new Date().toISOString()).run();

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
    const upload = await uploadRowQuery(context.env.DB, mediaId);
    if (!upload || !uploadMatchesRoute(upload, { importId, entryId, owner })) {
      return apiError(context, 404, "MEDIA_UPLOAD_NOT_FOUND", "找不到這個媒體上傳工作。");
    }
    if (upload.status === "completed" && upload.media_status === "ready") {
      const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
      noStore(context);
      return context.json(response);
    }
    if (upload.status === "aborted" || upload.status === "failed") {
      return apiError(context, 409, "MEDIA_UPLOAD_CLOSED", "這個媒體上傳工作已經結束。");
    }

    const media = await context.env.DB.prepare(`SELECT sha256 FROM media WHERE id = ?1`)
      .bind(mediaId)
      .first<{ sha256: string }>();
    if (!media) return apiError(context, 404, "MEDIA_UPLOAD_NOT_FOUND", "找不到這個媒體上傳工作。");

    const storedObject = await context.env.MEDIA.head(upload.r2_key);
    if (storedObject?.size === upload.size_bytes) {
      await finalizeUpload(context.env.DB, upload, media.sha256);
      const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
      noStore(context);
      return context.json(response);
    }

    const parts = await context.env.DB.prepare(`
      SELECT part_number, etag, size_bytes
      FROM media_upload_parts WHERE media_id = ?1 ORDER BY part_number
    `).bind(mediaId).all<PartRow>();
    const completeParts = parts.results.every(
      (part, index) =>
        part.part_number === index + 1 &&
        part.size_bytes === expectedPartSize(upload, part.part_number) &&
        ETAG_PATTERN.test(part.etag),
    );
    if (parts.results.length !== upload.part_count || !completeParts) {
      return apiError(context, 409, "MEDIA_UPLOAD_INCOMPLETE", "媒體尚未完整上傳，可以從中斷處繼續。");
    }

    await context.env.DB.prepare(`
      UPDATE media_uploads SET status = 'completing', updated_at = ?2 WHERE media_id = ?1
    `).bind(mediaId, new Date().toISOString()).run();

    let completedSizeMismatch = false;
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
      if (completedSizeMismatch) {
        const now = new Date().toISOString();
        await context.env.DB.batch([
          context.env.DB.prepare(`
            UPDATE media SET status = 'failed', updated_at = ?2 WHERE id = ?1
          `).bind(mediaId, now),
          context.env.DB.prepare(`
            UPDATE media_uploads SET status = 'failed', updated_at = ?2 WHERE media_id = ?1
          `).bind(mediaId, now),
          importItemStatement(context.env.DB, {
            importId,
            sourcePath: upload.source_path,
            mediaId,
            checksum: media.sha256,
            status: "failed",
            errorCode: "MEDIA_SIZE_MISMATCH",
            now,
          }),
        ]);
        return apiError(context, 500, "MEDIA_SIZE_MISMATCH", "媒體大小驗證失敗，請重新開始上傳。");
      }
      const completedObject = await context.env.MEDIA.head(upload.r2_key);
      if (completedObject?.size !== upload.size_bytes) {
        await context.env.DB.prepare(`
          UPDATE media_uploads SET status = 'uploading', updated_at = ?2 WHERE media_id = ?1
        `).bind(mediaId, new Date().toISOString()).run();
        return apiError(context, 500, "MEDIA_UPLOAD_COMPLETE_FAILED", "媒體完成上傳失敗，可以稍後重試。");
      }
    }

    await finalizeUpload(context.env.DB, upload, media.sha256);
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
    if (upload.status === "completed") return context.body(null, 204);

    await context.env.MEDIA
      .resumeMultipartUpload(upload.r2_key, upload.upload_id)
      .abort()
      .catch(() => undefined);
    const media = await context.env.DB.prepare(`SELECT sha256 FROM media WHERE id = ?1`)
      .bind(mediaId)
      .first<{ sha256: string }>();
    const now = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE media SET status = 'failed', updated_at = ?2 WHERE id = ?1
      `).bind(mediaId, now),
      context.env.DB.prepare(`
        UPDATE media_uploads SET status = 'aborted', updated_at = ?2 WHERE media_id = ?1
      `).bind(mediaId, now),
      importItemStatement(context.env.DB, {
        importId,
        sourcePath: upload.source_path,
        mediaId,
        checksum: media?.sha256 ?? "0".repeat(64),
        status: "failed",
        errorCode: "UPLOAD_ABORTED",
        now,
      }),
    ]);
    noStore(context);
    return context.body(null, 204);
  },
);
