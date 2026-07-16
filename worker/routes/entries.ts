import { Hono } from "hono";
import { z } from "zod";
import type {
  CreateEntryResponse,
  DeleteEntryResponse,
  EntryBlock,
  EntryDetail,
  LayoutPreset,
  MediaPreview,
  RemoveEntryMediaResponse,
  RestoreEntryResponse,
  TimelineEntry,
  TimelineResponse,
  UpdateEntryResponse,
  UploadEntryMediaResponse,
} from "../../shared/api";
import { createEntrySchema, updateEntrySchema } from "../../shared/schemas";
import type { AuthVariables } from "../lib/auth/middleware";
import { buildExcerpt, countWords } from "../lib/entry-content";
import { apiError, noStore } from "../lib/http";
import {
  type EntryMediaRow,
  mediaPreviewFromRow,
  mediaR2Key,
  parseMediaUpload,
  uploadMediaObject,
  validatedMediaBody,
} from "../lib/media";

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(12),
  before: z.iso.datetime().optional(),
});

// Same file-name/type/placement/caption query contract as the Apple Journal
// media route; position is computed server-side by appending to the entry.
const entryMediaQuerySchema = z.object({
  sourcePath: z.string().trim().min(1).max(1_000),
  type: z.enum(["photo", "video", "audio", "drawing"]),
  placement: z.enum(["inline", "grid", "cover"]).default("grid"),
  caption: z.string().max(500).default(""),
});

interface EntryRow {
  id: string;
  title: string;
  excerpt: string;
  occurred_at: string;
  local_date: string;
  timezone: string;
  location_name: string | null;
  mood: string | null;
  is_favorite: number;
  layout_preset: LayoutPreset;
  layout_seed: number;
  word_count: number;
  journal_name: string;
  journal_color: string;
}

interface TagRow {
  entry_id: string;
  name: string;
}

interface BlockRow {
  id: string;
  position: number;
  type: EntryBlock["type"];
  text_content: string | null;
  attrs_json: string;
}

export const entryRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

function uploadOwnerSubject(context: { get(key: "auth"): AuthVariables["auth"] }): string | null {
  const auth = context.get("auth");
  if (auth.mode === "session") return auth.subject;
  if (auth.mode === "local") return "local-development";
  return null;
}

function buildEntries(
  rows: EntryRow[],
  mediaRows: EntryMediaRow[],
  tagRows: TagRow[],
): TimelineEntry[] {
  const mediaByEntry = new Map<string, MediaPreview[]>();
  const tagsByEntry = new Map<string, string[]>();

  for (const media of mediaRows) {
    const current = mediaByEntry.get(media.entry_id) ?? [];
    current.push(mediaPreviewFromRow(media));
    mediaByEntry.set(media.entry_id, current);
  }

  for (const tag of tagRows) {
    const current = tagsByEntry.get(tag.entry_id) ?? [];
    current.push(tag.name);
    tagsByEntry.set(tag.entry_id, current);
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    occurredAt: row.occurred_at,
    localDate: row.local_date,
    location: row.location_name,
    mood: row.mood,
    isFavorite: row.is_favorite === 1,
    layoutPreset: row.layout_preset,
    layoutSeed: row.layout_seed,
    wordCount: row.word_count,
    journalName: row.journal_name,
    journalColor: row.journal_color,
    tags: tagsByEntry.get(row.id) ?? [],
    media: mediaByEntry.get(row.id) ?? [],
  }));
}

async function loadRelations(
  database: D1Database,
  entryIds: string[],
): Promise<{ media: EntryMediaRow[]; tags: TagRow[] }> {
  if (entryIds.length === 0) {
    return { media: [], tags: [] };
  }

  const placeholders = entryIds.map(() => "?").join(", ");
  const [mediaResult, tagResult] = await Promise.all([
    database
      .prepare(`
        SELECT
          media.id, entry_media.entry_id, media.type, media.r2_key, media.storage_kind,
          media.width, media.height, media.duration_ms, media.alt_text,
          entry_media.caption, entry_media.placement
        FROM entry_media
        JOIN media ON media.id = entry_media.media_id
        JOIN entries ON entries.id = entry_media.entry_id
        WHERE entry_media.entry_id IN (${placeholders})
          AND media.status = 'ready'
          AND (
            entries.source <> 'apple_journal'
            OR entry_media.import_generation_id = entries.import_generation_id
          )
        ORDER BY entry_media.entry_id, entry_media.position
      `)
      .bind(...entryIds)
      .all<EntryMediaRow>(),
    database
      .prepare(`
        SELECT entry_tags.entry_id, tags.name
        FROM entry_tags
        JOIN tags ON tags.id = entry_tags.tag_id
        WHERE entry_tags.entry_id IN (${placeholders})
        ORDER BY tags.name COLLATE NOCASE
      `)
      .bind(...entryIds)
      .all<TagRow>(),
  ]);

  return {
    media: mediaResult.results,
    tags: tagResult.results,
  };
}

entryRoutes.get("/entries", async (context) => {
  const parsed = timelineQuerySchema.safeParse(context.req.query());

  if (!parsed.success) {
    return apiError(context, 400, "INVALID_QUERY", "無法讀取這個時間軸範圍。" );
  }

  const { before, limit } = parsed.data;
  const statement = context.env.DB.prepare(`
    SELECT
      entries.id, entries.title, entries.excerpt, entries.occurred_at,
      entries.local_date, entries.timezone, entries.location_name, entries.mood,
      entries.is_favorite, entries.layout_preset, entries.layout_seed,
      entries.word_count, journals.name AS journal_name, journals.color AS journal_color
    FROM entries
    JOIN journals ON journals.id = entries.journal_id
    WHERE entries.deleted_at IS NULL
      AND entries.status = 'published'
      AND (?1 IS NULL OR entries.occurred_at < ?1)
    ORDER BY entries.occurred_at DESC
    LIMIT ?2
  `).bind(before ?? null, limit + 1);

  const result = await statement.all<EntryRow>();
  const hasMore = result.results.length > limit;
  const pageRows = result.results.slice(0, limit);
  const relations = await loadRelations(
    context.env.DB,
    pageRows.map((entry) => entry.id),
  );
  const entries = buildEntries(pageRows, relations.media, relations.tags);
  const response: TimelineResponse = {
    entries,
    nextCursor: hasMore ? entries.at(-1)?.occurredAt ?? null : null,
  };

  noStore(context);
  return context.json(response);
});

entryRoutes.post("/entries", async (context) => {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 120_000) {
    return apiError(context, 413, "ENTRY_TOO_LARGE", "這篇日記超過目前可接受的大小。" );
  }

  let payload: unknown;
  try {
    payload = await context.req.json();
  } catch {
    return apiError(context, 400, "INVALID_JSON", "日記內容格式不正確。" );
  }

  const parsed = createEntrySchema.safeParse(payload);
  if (!parsed.success) {
    return apiError(context, 400, "INVALID_ENTRY", "請檢查標題、日期與日記內容。" );
  }

  const input = parsed.data;
  const entryId = crypto.randomUUID();
  const blockId = crypto.randomUUID();
  const now = new Date().toISOString();
  const wordCount = countWords(`${input.title} ${input.body}`);
  const excerpt = buildExcerpt(input.body);

  await context.env.DB.batch([
    context.env.DB.prepare(`
      INSERT INTO entries (
        id, journal_id, source, title, excerpt, occurred_at, timezone, local_date,
        location_name, layout_seed, word_count, status, created_at, updated_at
      ) VALUES (?1, 'journal-everyday', 'native', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'published', ?10, ?10)
    `).bind(
      entryId,
      input.title,
      excerpt,
      input.occurredAt,
      input.timezone,
      input.localDate,
      input.location,
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
  ]);

  const response: CreateEntryResponse = { id: entryId, status: "published" };
  noStore(context);
  return context.json(response, 201);
});

entryRoutes.get("/entries/:entryId", async (context) => {
  const entryId = context.req.param("entryId");
  const row = await context.env.DB.prepare(`
    SELECT
      entries.id, entries.title, entries.excerpt, entries.occurred_at,
      entries.local_date, entries.timezone, entries.location_name, entries.mood,
      entries.is_favorite, entries.layout_preset, entries.layout_seed,
      entries.word_count, journals.name AS journal_name, journals.color AS journal_color
    FROM entries
    JOIN journals ON journals.id = entries.journal_id
    WHERE entries.id = ?1 AND entries.deleted_at IS NULL AND entries.status = 'published'
  `)
    .bind(entryId)
    .first<EntryRow>();

  if (!row) {
    return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇日記。" );
  }

  const [relations, blocksResult] = await Promise.all([
    loadRelations(context.env.DB, [entryId]),
    context.env.DB.prepare(`
      SELECT id, position, type, text_content, attrs_json
      FROM entry_blocks
      WHERE entry_id = ?1
      ORDER BY position
    `)
      .bind(entryId)
      .all<BlockRow>(),
  ]);
  const baseEntry = buildEntries([row], relations.media, relations.tags)[0];
  const blocks: EntryBlock[] = blocksResult.results.map((block) => {
    let attrs: Record<string, unknown> = {};

    try {
      const parsedAttrs: unknown = JSON.parse(block.attrs_json);
      if (typeof parsedAttrs === "object" && parsedAttrs !== null && !Array.isArray(parsedAttrs)) {
        attrs = parsedAttrs as Record<string, unknown>;
      }
    } catch {
      attrs = {};
    }

    return {
      id: block.id,
      position: block.position,
      type: block.type,
      text: block.text_content,
      attrs,
    };
  });
  const response: EntryDetail = {
    ...baseEntry,
    blocks,
    timezone: row.timezone,
  };

  noStore(context);
  return context.json(response);
});

entryRoutes.patch("/entries/:entryId", async (context) => {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 120_000) {
    return apiError(context, 413, "ENTRY_TOO_LARGE", "這篇日記超過目前可接受的大小。" );
  }

  let payload: unknown;
  try {
    payload = await context.req.json();
  } catch {
    return apiError(context, 400, "INVALID_JSON", "日記內容格式不正確。" );
  }

  const parsed = updateEntrySchema.safeParse(payload);
  if (!parsed.success) {
    return apiError(context, 400, "INVALID_ENTRY", "請檢查標題、日期與日記內容。" );
  }

  const entryId = context.req.param("entryId");
  const existing = await context.env.DB.prepare(`
    SELECT id, status FROM entries WHERE id = ?1 AND deleted_at IS NULL
  `)
    .bind(entryId)
    .first<{ id: string; status: string }>();

  if (!existing) {
    return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇日記。" );
  }

  const input = parsed.data;
  const blockId = crypto.randomUUID();
  const now = new Date().toISOString();
  const wordCount = countWords(`${input.title} ${input.body}`);
  const excerpt = buildExcerpt(input.body);

  // Replace every text block with one canonical paragraph — imported entries
  // collapse to the edited markdown by design — while media links stay put.
  await context.env.DB.batch([
    context.env.DB.prepare(`
      UPDATE entries SET
        title = ?2,
        excerpt = ?3,
        occurred_at = ?4,
        timezone = ?5,
        local_date = ?6,
        location_name = ?7,
        mood = ?8,
        word_count = ?9,
        updated_at = ?10
      WHERE id = ?1
    `).bind(
      entryId,
      input.title,
      excerpt,
      input.occurredAt,
      input.timezone,
      input.localDate,
      input.location,
      input.mood,
      wordCount,
      now,
    ),
    context.env.DB.prepare(`
      DELETE FROM entry_blocks WHERE entry_id = ?1 AND type != 'media'
    `).bind(entryId),
    context.env.DB.prepare(`
      INSERT INTO entry_blocks (
        id, entry_id, position, type, text_content, attrs_json, created_at, updated_at
      ) VALUES (?1, ?2, 0, 'paragraph', ?3, '{}', ?4, ?4)
    `).bind(blockId, entryId, input.body, now),
    context.env.DB.prepare(`DELETE FROM entry_search WHERE entry_id = ?1`).bind(entryId),
    context.env.DB.prepare(`
      INSERT INTO entry_search (entry_id, title, body) VALUES (?1, ?2, ?3)
    `).bind(entryId, input.title, input.body),
  ]);

  const response: UpdateEntryResponse = { id: entryId, status: existing.status };
  noStore(context);
  return context.json(response);
});

entryRoutes.delete("/entries/:entryId", async (context) => {
  const entryId = context.req.param("entryId");
  const existing = await context.env.DB.prepare(`
    SELECT id, deleted_at FROM entries WHERE id = ?1
  `)
    .bind(entryId)
    .first<{ id: string; deleted_at: string | null }>();

  if (!existing) {
    return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇日記。" );
  }

  // Idempotent: deleting an already soft-deleted entry reports the same state.
  if (existing.deleted_at) {
    const response: DeleteEntryResponse = { id: entryId, deletedAt: existing.deleted_at };
    noStore(context);
    return context.json(response);
  }

  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare(`
      UPDATE entries SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1
    `).bind(entryId, now),
    context.env.DB.prepare(`DELETE FROM entry_search WHERE entry_id = ?1`).bind(entryId),
  ]);

  const response: DeleteEntryResponse = { id: entryId, deletedAt: now };
  noStore(context);
  return context.json(response);
});

entryRoutes.post("/entries/:entryId/restore", async (context) => {
  const entryId = context.req.param("entryId");
  const existing = await context.env.DB.prepare(`
    SELECT id, title, status FROM entries WHERE id = ?1
  `)
    .bind(entryId)
    .first<{ id: string; title: string; status: string }>();

  if (!existing) {
    return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇日記。" );
  }

  // Rebuild the derived FTS row from the canonical blocks; running this on an
  // entry that was never deleted is a harmless no-op rebuild (idempotent).
  const blocksResult = await context.env.DB.prepare(`
    SELECT text_content
    FROM entry_blocks
    WHERE entry_id = ?1 AND text_content IS NOT NULL
    ORDER BY position
  `)
    .bind(entryId)
    .all<{ text_content: string }>();
  const body = blocksResult.results.map((block) => block.text_content).join("\n\n");
  const now = new Date().toISOString();

  await context.env.DB.batch([
    context.env.DB.prepare(`
      UPDATE entries SET deleted_at = NULL, updated_at = ?2 WHERE id = ?1
    `).bind(entryId, now),
    context.env.DB.prepare(`DELETE FROM entry_search WHERE entry_id = ?1`).bind(entryId),
    context.env.DB.prepare(`
      INSERT INTO entry_search (entry_id, title, body) VALUES (?1, ?2, ?3)
    `).bind(entryId, existing.title, body),
  ]);

  const response: RestoreEntryResponse = { id: entryId, status: existing.status };
  noStore(context);
  return context.json(response);
});

async function readEntryMediaRow(
  database: D1Database,
  entryId: string,
  mediaId: string,
): Promise<EntryMediaRow | null> {
  return database
    .prepare(`
      SELECT
        media.id, entry_media.entry_id, media.type, media.r2_key, media.storage_kind,
        media.width, media.height, media.duration_ms, media.alt_text,
        entry_media.caption, entry_media.placement
      FROM entry_media
      JOIN media ON media.id = entry_media.media_id
      WHERE entry_media.entry_id = ?1 AND entry_media.media_id = ?2
    `)
    .bind(entryId, mediaId)
    .first<EntryMediaRow>();
}

entryRoutes.post("/entries/:entryId/media", async (context) => {
  const entryId = context.req.param("entryId");
  const query = entryMediaQuerySchema.safeParse(context.req.query());
  const upload = parseMediaUpload(context.req);

  if (!query.success || !upload) {
    return apiError(context, 400, "INVALID_IMPORT_MEDIA", "這個媒體格式不完整。" );
  }

  const entry = await context.env.DB.prepare(`
    SELECT id FROM entries WHERE id = ?1 AND deleted_at IS NULL
  `)
    .bind(entryId)
    .first<{ id: string }>();

  if (!entry) {
    return apiError(context, 404, "ENTRY_NOT_FOUND", "找不到這篇日記。" );
  }

  const input = query.data;
  const ownerSubject = uploadOwnerSubject(context);
  if (!ownerSubject) return apiError(context, 403, "UPLOAD_NOT_ALLOWED", "沒有權限上傳這個媒體。" );
  const now = new Date().toISOString();
  // Appends after the entry's current media; INSERT OR IGNORE keeps re-linking
  // the same media idempotent.
  const linkStatement = (mediaId: string) =>
    context.env.DB.prepare(`
      INSERT OR IGNORE INTO entry_media (
        entry_id, media_id, position, placement, caption
      ) VALUES (
        ?1, ?2,
        (SELECT COALESCE(MAX(position) + 1, 0) FROM entry_media WHERE entry_id = ?1),
        ?3, ?4
      )
    `).bind(entryId, mediaId, input.placement, input.caption);

  const existingMedia = await context.env.DB.prepare(`
    SELECT id, status, r2_key, owner_subject FROM media WHERE sha256 = ?1
  `)
    .bind(upload.fingerprint)
    .first<{ id: string; status: string; r2_key: string; owner_subject: string | null }>();

  if (existingMedia) {
    if (existingMedia.owner_subject && existingMedia.owner_subject !== ownerSubject) {
      return apiError(context, 409, "MEDIA_FINGERPRINT_CONFLICT", "這個媒體識別碼已被其他資料使用。" );
    }
    const alreadyLinked = await context.env.DB.prepare(`
      SELECT 1 AS linked FROM entry_media WHERE entry_id = ?1 AND media_id = ?2
    `)
      .bind(entryId, existingMedia.id)
      .first<{ linked: number }>();

    const statements: D1PreparedStatement[] = [];

    // A previous failed upload left the row without a usable object: retry the
    // object write with the fresh bytes before reusing the media row.
    if (existingMedia.status !== "ready") {
      const validatedBody = await validatedMediaBody(upload.body, input.type, upload.mimeType);
      if (!validatedBody) {
        return apiError(context, 400, "MEDIA_SIGNATURE_MISMATCH", "媒體內容與檔案類型不一致。" );
      }
      try {
        const object = await context.env.MEDIA.put(existingMedia.r2_key, validatedBody, {
          httpMetadata: { contentType: upload.mimeType },
        });
        if (!object || object.size !== upload.sizeBytes) {
          await context.env.MEDIA.delete(existingMedia.r2_key);
          throw new Error("Uploaded media size did not match its declaration");
        }
      } catch {
        return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以稍後再試一次。" );
      }
      statements.push(
        context.env.DB.prepare(`
          UPDATE media SET status = 'ready', owner_subject = ?2, updated_at = ?3 WHERE id = ?1
        `).bind(existingMedia.id, ownerSubject, now),
      );
    } else if (!existingMedia.owner_subject) {
      statements.push(
        context.env.DB.prepare(`
          UPDATE media SET owner_subject = ?2, updated_at = ?3 WHERE id = ?1
        `).bind(existingMedia.id, ownerSubject, now),
      );
    }

    if (!alreadyLinked) {
      statements.push(linkStatement(existingMedia.id));
    }

    if (statements.length > 0) {
      await context.env.DB.batch(statements);
    }

    const row = await readEntryMediaRow(context.env.DB, entryId, existingMedia.id);
    if (!row) {
      return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以稍後再試一次。" );
    }

    const response: UploadEntryMediaResponse = { media: mediaPreviewFromRow(row) };
    noStore(context);
    return context.json(response, alreadyLinked ? 200 : 201);
  }

  const mediaId = crypto.randomUUID();
  const r2Key = mediaR2Key("uploads", mediaId, input.sourcePath);
  const validatedBody = await validatedMediaBody(upload.body, input.type, upload.mimeType);
  if (!validatedBody) {
    return apiError(context, 400, "MEDIA_SIGNATURE_MISMATCH", "媒體內容與檔案類型不一致。" );
  }
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
    successStatements: [linkStatement(mediaId)],
  });

  if (!uploaded) {
    return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以稍後再試一次。" );
  }

  const row = await readEntryMediaRow(context.env.DB, entryId, mediaId);
  if (!row) {
    return apiError(context, 500, "MEDIA_UPLOAD_FAILED", "媒體上傳失敗，可以稍後再試一次。" );
  }

  const response: UploadEntryMediaResponse = { media: mediaPreviewFromRow(row) };
  noStore(context);
  return context.json(response, 201);
});

entryRoutes.delete("/entries/:entryId/media/:mediaId", async (context) => {
  const entryId = context.req.param("entryId");
  const mediaId = context.req.param("mediaId");
  const link = await context.env.DB.prepare(`
    SELECT
      media.r2_key, media.storage_kind,
      (SELECT COUNT(*) FROM entry_media WHERE media_id = ?2) AS reference_count
    FROM entry_media
    JOIN media ON media.id = entry_media.media_id
    WHERE entry_media.entry_id = ?1 AND entry_media.media_id = ?2
  `)
    .bind(entryId, mediaId)
    .first<{
      r2_key: string;
      storage_kind: "private_r2" | "demo_asset";
      reference_count: number;
    }>();

  if (!link) {
    return apiError(context, 404, "MEDIA_NOT_FOUND", "找不到這個媒體。" );
  }

  const lastReference = link.reference_count <= 1;

  // Delete the object before the rows: if R2 fails we return 500 with the rows
  // intact (retryable), whereas the reverse order could orphan the object.
  // Shared deduplicated media with other references keeps its object and row.
  if (lastReference && link.storage_kind === "private_r2") {
    await context.env.MEDIA.delete(link.r2_key);
  }

  const statements = [
    context.env.DB.prepare(`
      DELETE FROM entry_media WHERE entry_id = ?1 AND media_id = ?2
    `).bind(entryId, mediaId),
  ];
  if (lastReference) {
    statements.push(context.env.DB.prepare(`DELETE FROM media WHERE id = ?1`).bind(mediaId));
  }
  await context.env.DB.batch(statements);

  const response: RemoveEntryMediaResponse = { removed: true };
  noStore(context);
  return context.json(response);
});

entryRoutes.get("/media/:mediaId", async (context) => {
  const mediaId = context.req.param("mediaId");
  const media = await context.env.DB.prepare(`
    SELECT media.r2_key, media.storage_kind
    FROM media
    WHERE media.id = ?1 AND media.status = 'ready'
      AND (
        media.storage_kind = 'demo_asset'
        OR EXISTS (
          SELECT 1
          FROM entry_media
          JOIN entries ON entries.id = entry_media.entry_id
          WHERE entry_media.media_id = media.id
            AND entries.status = 'published'
            AND entries.deleted_at IS NULL
            AND (
              entries.source <> 'apple_journal'
              OR entry_media.import_generation_id = entries.import_generation_id
            )
        )
      )
  `)
    .bind(mediaId)
    .first<{ r2_key: string; storage_kind: "private_r2" | "demo_asset" }>();

  if (!media) {
    return apiError(context, 404, "MEDIA_NOT_FOUND", "找不到這個媒體。" );
  }

  if (media.storage_kind === "demo_asset") {
    return context.redirect(`/${media.r2_key}`, 302);
  }

  const rangeHeader = context.req.header("Range");
  const object = await context.env.MEDIA.get(
    media.r2_key,
    rangeHeader ? { range: context.req.raw.headers } : undefined,
  );

  if (!object) {
    return apiError(context, 404, "MEDIA_OBJECT_NOT_FOUND", "媒體檔案不存在。" );
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");

  if (rangeHeader && object.range) {
    const offset = "offset" in object.range ? object.range.offset ?? 0 : 0;
    const length = "length" in object.range ? object.range.length ?? object.size : object.size;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
  }

  return new Response(object.body, {
    status: rangeHeader && object.range ? 206 : 200,
    headers,
  });
});
