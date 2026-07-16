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
import { buildExcerpt, countWords } from "../lib/entry-content";
import { apiError, noStore } from "../lib/http";
import type { AuthVariables } from "../lib/auth/middleware";
import { reconcileImportedEntryStatements } from "../lib/import-status";
import {
  mediaR2Key,
  parseMediaUpload,
  uploadMediaObject,
  validatedMediaBody,
} from "../lib/media";

const startImportSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  entryCount: z.number().int().min(1).max(50_000),
  mediaCount: z.number().int().min(0).max(50_000),
}) satisfies z.ZodType<StartAppleJournalImportInput>;

const importEntrySchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_000),
  mediaCount: z.number().int().min(0).max(10_000),
  title: z.string().trim().min(1).max(180),
  body: z.string().max(100_000),
  occurredAt: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(80),
  localDate: z.iso.date(),
  location: z.string().trim().max(180).nullable(),
  mood: z.string().trim().max(40).nullable(),
}) satisfies z.ZodType<ImportAppleJournalEntryInput>;

const mediaQuerySchema = z.object({
  generationId: z.uuid(),
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

interface ExistingEntryRow {
  id: string;
  source_hash: string | null;
}

interface ExistingMediaRow {
  id: string;
  r2_key: string;
  status: string;
  owner_subject: string | null;
}

export const importRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function uploadOwnerSubject(context: { get(key: "auth"): AuthVariables["auth"] }): string | null {
  const auth = context.get("auth");
  if (auth.mode === "session") return auth.subject;
  if (auth.mode === "local") return "local-development";
  return null;
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

function importGenerationStatement(
  database: D1Database,
  input: {
    entryId: string;
    generationId: string;
    expectedMediaCount: number;
    now: string;
  },
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO entry_import_generations (
      entry_id, generation_id, expected_media_count, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?4)
    ON CONFLICT(entry_id) DO UPDATE SET
      generation_id = excluded.generation_id,
      expected_media_count = excluded.expected_media_count,
      updated_at = excluded.updated_at
  `).bind(input.entryId, input.generationId, input.expectedMediaCount, input.now);
}

async function readJson(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

importRoutes.post("/imports/apple-journal", async (context) => {
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
  const generationId = crypto.randomUUID();
  const now = new Date().toISOString();
  const blockId = crypto.randomUUID();
  const wordCount = countWords(`${input.title} ${input.body}`);
  const excerpt = buildExcerpt(input.body);
  const duplicate = existing?.source_hash === sourceHash;

  if (duplicate) {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE entries SET
          import_generation_id = ?2, status = 'partial-import',
          deleted_at = NULL, updated_at = ?3
        WHERE id = ?1
      `).bind(entryId, generationId, now),
      importGenerationStatement(context.env.DB, {
        entryId,
        generationId,
        expectedMediaCount: input.mediaCount,
        now,
      }),
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
      ...reconcileImportedEntryStatements(context.env.DB, entryId, generationId, now),
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
          import_generation_id = ?13,
          status = 'partial-import',
          updated_at = ?14,
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
        generationId,
        now,
      ),
      importGenerationStatement(context.env.DB, {
        entryId,
        generationId,
        expectedMediaCount: input.mediaCount,
        now,
      }),
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
      ...reconcileImportedEntryStatements(context.env.DB, entryId, generationId, now),
    ]);
  } else {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        INSERT INTO entries (
          id, journal_id, source, source_id, source_hash, title, excerpt,
          occurred_at, timezone, local_date, location_name, mood, layout_seed,
          word_count, import_generation_id, status, created_at, updated_at
        ) VALUES (
          ?1, 'journal-everyday', 'apple_journal', ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'partial-import',
          ?14, ?14
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
        generationId,
        now,
      ),
      importGenerationStatement(context.env.DB, {
        entryId,
        generationId,
        expectedMediaCount: input.mediaCount,
        now,
      }),
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
      ...reconcileImportedEntryStatements(context.env.DB, entryId, generationId, now),
    ]);
  }

  const response: ImportAppleJournalEntryResponse = {
    id: entryId,
    generationId,
    disposition: duplicate ? "duplicate" : existing ? "updated" : "inserted",
  };
  noStore(context);
  return context.json(response, existing ? 200 : 201);
});

importRoutes.post("/imports/apple-journal/:importId/entries/:entryId/media", async (context) => {
  const importId = context.req.param("importId");
  const entryId = context.req.param("entryId");
  const query = mediaQuerySchema.safeParse(context.req.query());
  const upload = parseMediaUpload(context.req);

  if (!query.success || !upload) {
    return apiError(context, 400, "INVALID_IMPORT_MEDIA", "這個 Apple Journal 媒體格式不完整。");
  }

  const [importJob, entry] = await Promise.all([
    context.env.DB.prepare(`SELECT id FROM imports WHERE id = ?1`).bind(importId).first<{ id: string }>(),
    context.env.DB.prepare(`
      SELECT id, import_generation_id FROM entries
      WHERE id = ?1 AND source = 'apple_journal'
    `)
      .bind(entryId)
      .first<{ id: string; import_generation_id: string | null }>(),
  ]);
  if (!importJob) return apiError(context, 404, "IMPORT_NOT_FOUND", "找不到這次匯入工作。");
  if (!entry) return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇匯入日記。");
  if (entry.import_generation_id !== query.data.generationId) {
    return apiError(context, 409, "ENTRY_IMPORT_GENERATION_CHANGED", "這篇日記已有更新的匯入工作，請重新開始。");
  }

  const input = query.data;
  const ownerSubject = uploadOwnerSubject(context);
  if (!ownerSubject) return apiError(context, 403, "UPLOAD_NOT_ALLOWED", "沒有權限上傳這個媒體。");
  const existingMedia = await context.env.DB.prepare(`
    SELECT id, r2_key, status, owner_subject FROM media WHERE sha256 = ?1
  `)
    .bind(upload.fingerprint)
    .first<ExistingMediaRow>();
  const now = new Date().toISOString();

  if (existingMedia?.owner_subject && existingMedia.owner_subject !== ownerSubject) {
    return apiError(context, 409, "MEDIA_FINGERPRINT_CONFLICT", "這個媒體識別碼已被其他資料使用。");
  }

  if (existingMedia?.status === "ready") {
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE media SET owner_subject = ?2, updated_at = ?3 WHERE id = ?1
      `).bind(existingMedia.id, ownerSubject, now),
      importedMediaLinkStatement(context.env.DB, {
        entryId,
        generationId: input.generationId,
        mediaId: existingMedia.id,
        position: input.position,
        placement: input.placement,
        caption: input.caption,
      }),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: existingMedia.id,
        checksum: upload.fingerprint,
        kind: "media",
        status: "duplicate",
        now,
      }),
      ...reconcileImportedEntryStatements(context.env.DB, entryId, input.generationId, now),
    ]);

    const response: ImportAppleJournalMediaResponse = {
      id: existingMedia.id,
      disposition: "duplicate",
    };
    noStore(context);
    return context.json(response);
  }

  const validatedBody = await validatedMediaBody(upload.body, input.type, upload.mimeType);
  if (!validatedBody) {
    return apiError(context, 400, "MEDIA_SIGNATURE_MISMATCH", "媒體內容與檔案類型不一致。");
  }

  if (existingMedia) {
    try {
      const object = await context.env.MEDIA.put(existingMedia.r2_key, validatedBody, {
        httpMetadata: { contentType: upload.mimeType },
      });
      if (!object || object.size !== upload.sizeBytes) {
        await context.env.MEDIA.delete(existingMedia.r2_key);
        throw new Error("Uploaded media size did not match its declaration");
      }
    } catch {
      return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以重新匯入後續傳。");
    }
    await context.env.DB.batch([
      context.env.DB.prepare(`
        UPDATE media SET
          status = 'ready', owner_subject = ?2, mime_type = ?3,
          size_bytes = ?4, updated_at = ?5
        WHERE id = ?1
      `).bind(existingMedia.id, ownerSubject, upload.mimeType, upload.sizeBytes, now),
      importedMediaLinkStatement(context.env.DB, {
        entryId,
        generationId: input.generationId,
        mediaId: existingMedia.id,
        position: input.position,
        placement: input.placement,
        caption: input.caption,
      }),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: existingMedia.id,
        checksum: upload.fingerprint,
        kind: "media",
        status: "completed",
        now,
      }),
      ...reconcileImportedEntryStatements(context.env.DB, entryId, input.generationId, now),
    ]);
    const response: ImportAppleJournalMediaResponse = {
      id: existingMedia.id,
      disposition: "inserted",
    };
    noStore(context);
    return context.json(response, 201);
  }

  const mediaId = crypto.randomUUID();
  const r2Key = mediaR2Key("imports", mediaId, input.sourcePath);
  const uploaded = await uploadMediaObject({
    db: context.env.DB,
    bucket: context.env.MEDIA,
    mediaId,
    r2Key,
    fingerprint: upload.fingerprint,
    type: input.type,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    body: validatedBody,
    ownerSubject,
    now,
    successStatements: [
      importedMediaLinkStatement(context.env.DB, {
        entryId,
        generationId: input.generationId,
        mediaId,
        position: input.position,
        placement: input.placement,
        caption: input.caption,
      }),
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: mediaId,
        checksum: upload.fingerprint,
        kind: "media",
        status: "completed",
        now,
      }),
      ...reconcileImportedEntryStatements(context.env.DB, entryId, input.generationId, now),
    ],
    failureStatements: [
      importItemStatement(context.env.DB, {
        id: crypto.randomUUID(),
        importId,
        sourcePath: input.sourcePath,
        sourceId: mediaId,
        checksum: upload.fingerprint,
        kind: "media",
        status: "failed",
        errorCode: "R2_UPLOAD_FAILED",
        now,
      }),
    ],
  });

  if (!uploaded) {
    return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以重新匯入後續傳。");
  }

  const response: ImportAppleJournalMediaResponse = { id: mediaId, disposition: "inserted" };
  noStore(context);
  return context.json(response, 201);
});

importRoutes.post("/imports/apple-journal/:importId/complete", async (context) => {
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
