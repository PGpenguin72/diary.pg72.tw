import { Hono } from "hono";
import { z } from "zod";
import type {
  CreateEntryInput,
  CreateEntryResponse,
  EntryBlock,
  EntryDetail,
  LayoutPreset,
  MediaPreview,
  MediaType,
  TimelineEntry,
  TimelineResponse,
} from "../../shared/api";
import { apiError, noStore } from "../lib/http";
import { hasWriteAccess } from "../lib/write-access";

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(12),
  before: z.iso.datetime().optional(),
});

const createEntrySchema = z.object({
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().min(1).max(100_000),
  occurredAt: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(80),
  localDate: z.iso.date(),
  location: z.string().trim().max(180).nullable(),
  mood: z.string().trim().max(40).nullable(),
}) satisfies z.ZodType<CreateEntryInput>;

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

interface MediaRow {
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

export const entryRoutes = new Hono<{ Bindings: Env }>();

function countWords(text: string): number {
  const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "word" });
  let count = 0;

  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike) {
      count += 1;
    }
  }

  return count;
}

function mediaSource(media: MediaRow): string {
  return media.storage_kind === "demo_asset"
    ? `/${media.r2_key}`
    : `/api/media/${media.id}`;
}

function buildEntries(
  rows: EntryRow[],
  mediaRows: MediaRow[],
  tagRows: TagRow[],
): TimelineEntry[] {
  const mediaByEntry = new Map<string, MediaPreview[]>();
  const tagsByEntry = new Map<string, string[]>();

  for (const media of mediaRows) {
    const current = mediaByEntry.get(media.entry_id) ?? [];
    current.push({
      id: media.id,
      type: media.type,
      src: mediaSource(media),
      width: media.width,
      height: media.height,
      durationMs: media.duration_ms,
      alt: media.alt_text,
      caption: media.caption,
      placement: media.placement,
    });
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
): Promise<{ media: MediaRow[]; tags: TagRow[] }> {
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
        WHERE entry_media.entry_id IN (${placeholders}) AND media.status = 'ready'
        ORDER BY entry_media.entry_id, entry_media.position
      `)
      .bind(...entryIds)
      .all<MediaRow>(),
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
  if (!hasWriteAccess(context.req.url)) {
    return apiError(context, 401, "AUTH_REQUIRED", "需要先登入才能新增日記。" );
  }

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
  const excerpt = input.body.replace(/\s+/g, " ").slice(0, 180);

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
    WHERE entries.id = ?1 AND entries.deleted_at IS NULL
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

entryRoutes.get("/media/:mediaId", async (context) => {
  const mediaId = context.req.param("mediaId");
  const media = await context.env.DB.prepare(`
    SELECT r2_key, storage_kind
    FROM media
    WHERE id = ?1 AND status = 'ready'
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
