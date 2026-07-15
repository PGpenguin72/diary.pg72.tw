export type MediaType = "photo" | "video" | "audio" | "drawing";
export type LayoutPreset = "auto" | "letter" | "film" | "contact-sheet" | "compact";

export interface MediaPreview {
  id: string;
  type: MediaType;
  src: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  alt: string;
  caption: string;
  placement: "inline" | "grid" | "cover";
}

export interface TimelineEntry {
  id: string;
  title: string;
  excerpt: string;
  occurredAt: string;
  localDate: string;
  location: string | null;
  mood: string | null;
  isFavorite: boolean;
  layoutPreset: LayoutPreset;
  layoutSeed: number;
  wordCount: number;
  journalName: string;
  journalColor: string;
  tags: string[];
  media: MediaPreview[];
}

export interface EntryBlock {
  id: string;
  position: number;
  type: "paragraph" | "heading" | "quote" | "list" | "media" | "location" | "mood" | "link";
  text: string | null;
  attrs: Record<string, unknown>;
}

export interface EntryDetail extends TimelineEntry {
  blocks: EntryBlock[];
  timezone: string;
}

export interface ActivityDay {
  date: string;
  entries: number;
  words: number;
}

export interface MonthlyWords {
  month: string;
  entries: number;
  words: number;
}

export interface OverviewResponse {
  stats: {
    totalEntries: number;
    totalDays: number;
    totalWords: number;
    photoCount: number;
    videoCount: number;
    audioCount: number;
    mediaBytes: number;
    currentStreak: number;
    longestStreak: number;
  };
  activity: ActivityDay[];
  monthly: MonthlyWords[];
}

export interface TimelineResponse {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

export interface CreateEntryInput {
  title: string;
  body: string;
  occurredAt: string;
  timezone: string;
  localDate: string;
  location: string | null;
  mood: string | null;
}

export interface CreateEntryResponse {
  id: string;
  status: "published";
}

export interface StartAppleJournalImportInput {
  fileName: string;
  fileFingerprint: string;
  entryCount: number;
  mediaCount: number;
}

export interface StartAppleJournalImportResponse {
  id: string;
  status: "processing";
}

export interface ImportAppleJournalEntryInput {
  sourcePath: string;
  title: string;
  body: string;
  occurredAt: string;
  timezone: string;
  localDate: string;
  location: string | null;
  mood: string | null;
}

export interface ImportAppleJournalEntryResponse {
  id: string;
  disposition: "inserted" | "updated" | "duplicate";
}

export interface ImportAppleJournalMediaResponse {
  id: string;
  disposition: "inserted" | "duplicate";
}

export interface CompleteAppleJournalImportInput {
  insertedCount: number;
  duplicateCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface CompleteAppleJournalImportResponse {
  status: "completed" | "completed-with-errors";
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
