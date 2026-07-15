import type { ActivityDay } from "../../shared/api";

interface HeatmapDay {
  date: string;
  entries: number;
  words: number;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildDays(activity: ActivityDay[]): HeatmapDay[] {
  const activityMap = new Map(activity.map((day) => [day.date, day]));
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - 83);

  return Array.from({ length: 84 }, (_, index) => {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    const key = dateKey(day);
    return activityMap.get(key) ?? { date: key, entries: 0, words: 0 };
  });
}

function activityLevel(words: number): number {
  if (words === 0) return 0;
  if (words < 150) return 1;
  if (words < 300) return 2;
  if (words < 450) return 3;
  return 4;
}

export function ActivityHeatmap({ activity }: { activity: ActivityDay[] }) {
  const days = buildDays(activity);

  return (
    <section className="activity-section">
      <div className="section-heading section-heading--compact">
        <div>
          <span>Writing rhythm</span>
          <h2>最近 12 週</h2>
        </div>
        <div className="heatmap-legend" aria-label="由少至多">
          {[0, 1, 2, 3, 4].map((level) => (
            <i data-level={level} key={level} />
          ))}
        </div>
      </div>

      <div className="heatmap" role="img" aria-label="最近十二週日記活動">
        {days.map((day) => (
          <span
            data-level={activityLevel(day.words)}
            key={day.date}
            title={`${day.date} · ${day.entries} 篇 · ${day.words} 字`}
          />
        ))}
      </div>
    </section>
  );
}
