import { Hono } from "hono";
import { z } from "zod";
import type {
  CompleteAppleJournalImportInput,
  CompleteAppleJournalImportResponse,
  ImportAppleJournalEntryInput,
  ImportAppleJournalEntryResponse,
  ImportAppleJournalMediaResponse,
  StartAppleJournalImportInput,
  StartAppleJournalImportResponse,
} from "../../shared/api";
import { apiError, noStore } from "../lib/http";
import { hasWriteAccess } from "../lib/write-access";

const startImportSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  entryCount: z.number().int().min(1).max(50_000),
  mediaCount: z.number().int().min(0).max(50_000),
}) satisfies z.ZodType<StartAppleJournalImportInput>;

const importEntrySchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_000),
  title: z.string().trim().min(1).max(180),
  body: z.string().max(100_000),
  occurredAt: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(80),
  localDate: z.iso.date(),
  location: z.string().trim().max(180).nullable(),
  mood: z.string().trim().max(40).nullable(),
}) satisfies z.ZodType<ImportAppleJournalEntryInput>;

const mediaQuerySchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_000),
  type: z.enum(["photo", "video", "audio", "drawing"]),
  position: z.coerce.number().int().min(0).max(10_000),
  placement: z.enum(["inline", "grid", "cover"]),
  caption: z.string().max(500).default(""),
});

const completeImportSchema = z.object({
  insertedCount: z.number().int().min(0),
  duplicateCount: z.number().int().min(0),
  skippedCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
}) satisfies z.ZodType<CompleteAppleJournalImportInput>;

const MAX_MEDIA_BYTES = 5 * 1024 * 1024 * 1024;

interface ExistingEntryRow {
  id: string;
  source_hash: string | null;
}

interface ExistingMediaRow {
  id: string;
}

export const importRoutes = new Hono<{ Bindings: Env }>();

function countWords(text: string): number {
  const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function importItemStatement(
  database: D1Database,
  input: {
    id: string;
    importId: string;
    sourcePath: string;
    sourceId: string | null;
    checksum: string | null;
    kind: "entry" | "media";
    status: "completed" | "duplicate" | "failed";
    errorCode?: string | null;
    now: string;
  },
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO import_items (
      id, import_id, source_path, source_id, checksum, kind, status,
      error_code, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
    ON CONFLICT(import_id, source_path) DO UPDATE SET
      source_id = excluded.source_id,
      checksum = excluded.checksum,
      kind = excluded.kind,
      status = excluded.status,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at
  `).bind(
    input.id,
    input.importId,
    input.sourcePath,
    input.sourceId,
    input.checksum,
    input.kind,
    input.status,
    input.errorCode ?? null,
    input.now,
  );
}

async function readJson(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

importRoutes.post("/imports/apple-journal", async (context) => {
  if (!hasWriteAccess(context.req.url)) {
    return apiError(context, 401, "AUTH_REQUIRED", "需要先登入才能匯入日記。");
  }

  const parsed = startImportSchema.safeParse(await readJson(context));
  if (!parsed.success) {
    return apiError(context, 400, "INVALID_IMPORT", "Apple Journal 匯入資訊不完整。");
  }

  const input = parsed.data;
  const existing = await context.env.DB.prepare(`
    SELECT id FROM imports WHERE file_fingerprint = ?1
  `)
    .bind(input.fileFingerprint)
    .first<{ id: string }>();
  const importId = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();

  if (existing) {
    await context.env.DB.prepare(`
      UPDATE imports SET
        file_name = ?2,
        status = 'processing',
        source_entry_count = ?3,
        source_attachment_count = ?4,
        updated_at = ?5,
        completed_at = NULL
      WHERE id = ?1
    `)
      .bind(importId, input.fileName, input.entryCount, input.mediaCount, now)
      .run();
  } else {
    await context.env.DB.prepare(`
      INSERT INTO imports (
        id, source, file_name, file_fingerprint, status,
        source_entry_count, source_attachment_count, created_at, updated_at
      ) VALUES (?1, 'apple_journal', ?2, ?3, 'processing', ?4, ?5, ?6, ?6)
    `)
      .bind(importId, input.fileName, input.fileFingerprint, input.entryCount, input.mediaCount, now)
      .run();
  }

  const response: StartAppleJournalImportResponse = { id: importId, status: "processing" };
  noStore(context);
  return context.json(response, existing ? 200 : 201);
});

importRoutes.post("/imports/apple-journal/:importId/entries", async (context) => {
  if (!hasWriteAccess(context.req.url)) {
    return apiError(context, 401, "AUTH_REQUIRED", "需要先登入才能匯入日記。");
  }

  const importId = context.req.param("importId");
  const parsed = importEntrySchema.safeParse(await readJson(context));
  if (!parsed.success) {
    return apiError(context, 400, "INVALID_IMPORT_ENTRY", "這篇 Apple Journal 日記格式不完整。");
  }

  const importJob = await context.env.DB.prepare(`SELECT id FROM imports WHERE id = ?1`)
    .bind(importId)
    .first<{ id: string }>();
  if (!importJob) return apiError(context, 404, "IMPORT_NOT_FOUND", "找不到這次匯入工作。");

  const input = parsed.data;
  const sourceHash = await sha256(
    JSON.stringify([
      input.title,
      input.body,
      input.occurredAt,
      input.timezone,
      input.localDate,
      input.location,
      input.mood,
    ]),
  );
  const existing = await context.env.DB.prepare(`
    SELECT id, source_hash
    FROM entries
    WHERE source = 'apple_journal' AND (source_id = ?1 OR source_hash = ?2)
    ORDER BY CASE WHEN source_id = ?1 THEN 0 ELSE 1 END
    LIMIT 1
  `)
    .bind(input.sourcePath, sourceHash)
    .first<ExistingEntryRow>();
  const entryId = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const blockId = crypto.randomUUID();
  const wordCount = countWords(`${input.title} ${input.body}`);
  const excerpt = input.body.replace(/\s+/g, " ").slice(0, 180);
  const duplicate = existing?.source_hash === sourceHash;

  if (duplicate) {
    await context.env.DB.batch([
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: entryId,
        checksum: sourceHash,
        kind: "entry",
        status: "duplicate",
        now,
      }),
    ]);
  } else if (existing) {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE entries SET
          source_id = ?2,
          source_hash = ?3,
          title = ?4,
          excerpt = ?5,
          occurred_at = ?6,
          timezone = ?7,
          local_date = ?8,
          location_name = ?9,
          mood = ?10,
          layout_seed = ?11,
          word_count = ?12,
          status = 'published',
          updated_at = ?13,
          deleted_at = NULL
        WHERE id = ?1
      `).bind(
        entryId,
        input.sourcePath,
        sourceHash,
        input.title,
        excerpt,
        input.occurredAt,
        input.timezone,
        input.localDate,
        input.location,
        input.mood,
        wordCount % 97,
        wordCount,
        now,
      ),
      context.env.DB.prepare(`DELETE FROM entry_blocks WHERE entry_id = ?1`).bind(entryId),
      context.env.DB.prepare(`
        INSERT INTO entry_blocks (
          id, entry_id, position, type, text_content, attrs_json, created_at, updated_at
        ) VALUES (?1, ?2, 0, 'paragraph', ?3, '{}', ?4, ?4)
      `).bind(blockId, entryId, input.body, now),
      context.env.DB.prepare(`DELETE FROM entry_search WHERE entry_id = ?1`).bind(entryId),
      context.env.DB.prepare(`
        INSERT INTO entry_search (entry_id, title, body) VALUES (?1, ?2, ?3)
      `).bind(entryId, input.title, input.body),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: entryId,
        checksum: sourceHash,
        kind: "entry",
        status: "completed",
        now,
      }),
    ]);
  } else {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO entries (
          id, journal_id, source, source_id, source_hash, title, excerpt,
          occurred_at, timezone, local_date, location_name, mood, layout_seed,
          word_count, status, created_at, updated_at
        ) VALUES (
          ?1, 'journal-everyday', 'apple_journal', ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'published', ?13, ?13
        )
      `).bind(
        entryId,
        input.sourcePath,
        sourceHash,
        input.title,
        excerpt,
        input.occurredAt,
        input.timezone,
        input.localDate,
        input.location,
        input.mood,
        wordCount % 97,
        wordCount,
        now,
      ),
      context.env.DB.prepare(`
        INSERT INTO entry_blocks (
          id, entry_id, position, type, text_content, attrs_json, created_at, updated_at
        ) VALUES (?1, ?2, 0, 'paragraph', ?3, '{}', ?4, ?4)
      `).bind(blockId, entryId, input.body, now),
      context.env.DB.prepare(`
        INSERT INTO entry_search (entry_id, title, body) VALUES (?1, ?2, ?3)
      `).bind(entryId, input.title, input.body),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: entryId,
        checksum: sourceHash,
        kind: "entry",
        status: "completed",
        now,
      }),
    ]);
  }

  const response: ImportAppleJournalEntryResponse = {
    id: entryId,
    disposition: duplicate ? "duplicate" : existing ? "updated" : "inserted",
  };
  noStore(context);
  return context.json(response, existing ? 200 : 201);
});

importRoutes.post("/imports/apple-journal/:importId/entries/:entryId/media", async (context) => {
  if (!hasWriteAccess(context.req.url)) {
    return apiError(context, 401, "AUTH_REQUIRED", "需要先登入才能匯入媒體。");
  }

  const importId = context.req.param("importId");
  const entryId = context.req.param("entryId");
  const query = mediaQuerySchema.safeParse(context.req.query());
  const fingerprint = context.req.header("X-Media-Fingerprint")?.toLowerCase();
  const contentType = context.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  const contentLength = Number(
    context.req.header("Content-Length") ?? context.req.header("X-Media-Size") ?? 0,
  );

  if (
    !query.success ||
    !fingerprint?.match(/^[a-f0-9]{64}$/) ||
    !contentType ||
    !Number.isFinite(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_MEDIA_BYTES ||
    !context.req.raw.body
  ) {
    return apiError(context, 400, "INVALID_IMPORT_MEDIA", "這個 Apple Journal 媒體格式不完整。");
  }

  const [importJob, entry] = await Promise.all([
    context.env.DB.prepare(`SELECT id FROM imports WHERE id = ?1`).bind(importId).first<{ id: string }>(),
    context.env.DB.prepare(`
      SELECT id FROM entries WHERE id = ?1 AND source = 'apple_journal'
    `)
      .bind(entryId)
      .first<{ id: string }>(),
  ]);
  if (!importJob) return apiError(context, 404, "IMPORT_NOT_FOUND", "找不到這次匯入工作。");
  if (!entry) return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇匯入日記。");

  const input = query.data;
  const existingMedia = await context.env.DB.prepare(`SELECT id FROM media WHERE sha256 = ?1`)
    .bind(fingerprint)
    .first<ExistingMediaRow>();
  const now = new Date().toISOString();

  if (existingMedia) {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT OR IGNORE INTO entry_media (
          entry_id, media_id, position, placement, caption
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).bind(entryId, existingMedia.id, input.position, input.placement, input.caption),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: existingMedia.id,
        checksum: fingerprint,
        kind: "media",
        status: "duplicate",
        now,
      }),
    ]);

    const response: ImportAppleJournalMediaResponse = {
      id: existingMedia.id,
      disposition: "duplicate",
    };
    noStore(context);
    return context.json(response);
  }

  const mediaId = crypto.randomUUID();
  const extensionMatch = input.sourcePath.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  const r2Key = `imports/${mediaId}${extensionMatch ? `.${extensionMatch[1]}` : ""}`;

  await context.env.DB.prepare(`
    INSERT INTO media (
      id, r2_key, storage_kind, sha256, type, mime_type, size_bytes,
      status, created_at, updated_at
    ) VALUES (?1, ?2, 'private_r2', ?3, ?4, ?5, ?6, 'uploading', ?7, ?7)
  `)
    .bind(mediaId, r2Key, fingerprint, input.type, contentType, contentLength, now)
    .run();

  try {
    await context.env.MEDIA.put(r2Key, context.req.raw.body, {
      httpMetadata: { contentType },
    });
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE media SET status = 'ready', updated_at = ?2 WHERE id = ?1
      `).bind(mediaId, new Date().toISOString()),
      context.env.DB.prepare(`
        INSERT OR IGNORE INTO entry_media (
          entry_id, media_id, position, placement, caption
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `).bind(entryId, mediaId, input.position, input.placement, input.caption),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: mediaId,
        checksum: fingerprint,
        kind: "media",
        status: "completed",
        now,
      }),
    ]);
  } catch {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE media SET status = 'failed', updated_at = ?2 WHERE id = ?1
      `).bind(mediaId, new Date().toISOString()),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: mediaId,
        checksum: fingerprint,
        kind: "media",
        status: "failed",
        errorCode: "R2_UPLOAD_FAILED",
        now,
      }),
    ]);
    return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以重新匯入後續傳。");
  }

  const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
  noStore(context);
  return context.json(response, 201);
});

importRoutes.post("/imports/apple-journal/:importId/complete", async (context) => {
  if (!hasWriteAccess(context.req.url)) {
    return apiError(context, 401, "AUTH_REQUIRED", "需要先登入才能完成匯入。");
  }

  const parsed = completeImportSchema.safeParse(await readJson(context));
  if (!parsed.success) {
    return apiError(context, 400, "INVALID_IMPORT_SUMMARY", "匯入結果格式不完整。");
  }

  const importId = context.req.param("importId");
  const input = parsed.data;
  const status = input.failedCount > 0 ? "completed-with-errors" : "completed";
  const now = new Date().toISOString();
  const result = await context.env.DB.prepare(`
    UPDATE imports SET
      status = ?2,
      inserted_count = ?3,
      duplicate_count = ?4,
      skipped_count = ?5,
      failed_count = ?6,
      updated_at = ?7,
      completed_at = ?7
    WHERE id = ?1
  `)
    .bind(
      importId,
      status,
      input.insertedCount,
      input.duplicateCount,
      input.skippedCount,
      input.failedCount,
      now,
    )
    .run();

  if (result.meta.changes === 0) {
    return apiError(context, 404, "IMPORT_NOT_FOUND", "找不到這次匯入工作。");
  }

  const response: CompleteAppleJournalImportResponse = { status };
  noStore(context);
  return context.json(response);
});
