import { Hono } from "hono";
import type { ActivityDay, MonthlyWords, OverviewResponse } from "../../shared/api";
import { noStore } from "../lib/http";
import { calculateStreaks } from "../lib/streaks";

interface EntryTotalsRow {
  total_entries: number;
  total_days: number;
  total_words: number;
}

interface MediaTotalsRow {
  photo_count: number;
  video_count: number;
  audio_count: number;
  media_bytes: number;
}

interface ActivityRow {
  date: string;
  entries: number;
  words: number;
}

interface MonthlyRow {
  month: string;
  entries: number;
  words: number;
}

export const overviewRoutes = new Hono<{ Bindings: Env }>();

overviewRoutes.get("/overview", async (context) => {
  const [entries, media, activityResult, monthlyResult] = await Promise.all([
    context.env.DB.prepare(`
      SELECT
        COUNT(*) AS total_entries,
        COUNT(DISTINCT local_date) AS total_days,
        COALESCE(SUM(word_count), 0) AS total_words
      FROM entries
      WHERE deleted_at IS NULL AND status = 'published'
    `).first<EntryTotalsRow>(),
    context.env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN media.type = 'photo' THEN 1 ELSE 0 END), 0) AS photo_count,
        COALESCE(SUM(CASE WHEN media.type = 'video' THEN 1 ELSE 0 END), 0) AS video_count,
        COALESCE(SUM(CASE WHEN media.type = 'audio' THEN 1 ELSE 0 END), 0) AS audio_count,
        COALESCE(SUM(media.size_bytes), 0) AS media_bytes
      FROM media
      WHERE EXISTS (
        SELECT 1
        FROM entry_media
        JOIN entries ON entries.id = entry_media.entry_id
        WHERE entry_media.media_id = media.id
          AND entries.deleted_at IS NULL
          AND entries.status = 'published'
          AND (
            entries.source <> 'apple_journal'
            OR entry_media.import_generation_id = entries.import_generation_id
          )
      )
    `).first<MediaTotalsRow>(),
    context.env.DB.prepare(`
      SELECT local_date AS date, COUNT(*) AS entries, SUM(word_count) AS words
      FROM entries
      WHERE deleted_at IS NULL AND status = 'published'
      GROUP BY local_date
      ORDER BY local_date ASC
    `).all<ActivityRow>(),
    context.env.DB.prepare(`
      SELECT SUBSTR(local_date, 1, 7) AS month, COUNT(*) AS entries, SUM(word_count) AS words
      FROM entries
      WHERE deleted_at IS NULL AND status = 'published'
      GROUP BY SUBSTR(local_date, 1, 7)
      ORDER BY month ASC
      LIMIT 12
    `).all<MonthlyRow>(),
  ]);

  const activity = activityResult.results;
  const monthly = monthlyResult.results;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const streaks = calculateStreaks(
    activity.map((day) => day.date),
    today,
  );

  const response: OverviewResponse = {
    stats: {
      totalEntries: entries?.total_entries ?? 0,
      totalDays: entries?.total_days ?? 0,
      totalWords: entries?.total_words ?? 0,
      photoCount: media?.photo_count ?? 0,
      videoCount: media?.video_count ?? 0,
      audioCount: media?.audio_count ?? 0,
      mediaBytes: media?.media_bytes ?? 0,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
    },
    activity: activity satisfies ActivityDay[],
    monthly: monthly satisfies MonthlyWords[],
  };

  noStore(context);
  return context.json(response);
});
