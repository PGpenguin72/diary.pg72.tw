import { z } from "zod";
import type {
  CreateEntryResponse,
  EntryDetail,
  OverviewResponse,
  TimelineResponse,
} from "./api";

const mediaPreviewSchema = z.object({
  id: z.string(),
  type: z.enum(["photo", "video", "audio", "drawing"]),
  src: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  alt: z.string(),
  caption: z.string(),
  placement: z.enum(["inline", "grid", "cover"]),
});

const timelineEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  excerpt: z.string(),
  occurredAt: z.string(),
  localDate: z.string(),
  location: z.string().nullable(),
  mood: z.string().nullable(),
  isFavorite: z.boolean(),
  layoutPreset: z.enum(["auto", "letter", "film", "contact-sheet", "compact"]),
  layoutSeed: z.number(),
  wordCount: z.number(),
  journalName: z.string(),
  journalColor: z.string(),
  tags: z.array(z.string()),
  media: z.array(mediaPreviewSchema),
});

const entryBlockSchema = z.object({
  id: z.string(),
  position: z.number(),
  type: z.enum(["paragraph", "heading", "quote", "list", "media", "location", "mood", "link"]),
  text: z.string().nullable(),
  attrs: z.record(z.string(), z.unknown()),
});

export const overviewResponseSchema = z.object({
  stats: z.object({
    totalEntries: z.number(),
    totalDays: z.number(),
    totalWords: z.number(),
    photoCount: z.number(),
    videoCount: z.number(),
    audioCount: z.number(),
    mediaBytes: z.number(),
    currentStreak: z.number(),
    longestStreak: z.number(),
  }),
  activity: z.array(
    z.object({
      date: z.string(),
      entries: z.number(),
      words: z.number(),
    }),
  ),
  monthly: z.array(
    z.object({
      month: z.string(),
      entries: z.number(),
      words: z.number(),
    }),
  ),
}) satisfies z.ZodType<OverviewResponse>;

export const timelineResponseSchema = z.object({
  entries: z.array(timelineEntrySchema),
  nextCursor: z.string().nullable(),
}) satisfies z.ZodType<TimelineResponse>;

export const entryDetailSchema = timelineEntrySchema.extend({
  blocks: z.array(entryBlockSchema),
  timezone: z.string(),
}) satisfies z.ZodType<EntryDetail>;

export const createEntryResponseSchema = z.object({
  id: z.string(),
  status: z.literal("published"),
}) satisfies z.ZodType<CreateEntryResponse>;
