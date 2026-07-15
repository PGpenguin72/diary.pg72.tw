import { ArrowUpRight, MapPin, PenLine } from "lucide-react";
import type { ActivityDay, MonthlyWords, TimelineEntry } from "../../shared/api";
import { formatMonth, formatNumber } from "../lib/format";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { EntryCard } from "./EntryCard";
import { StatsStrip } from "./StatsStrip";

interface OverviewViewProps {
  entries: TimelineEntry[];
  activity: ActivityDay[];
  monthly: MonthlyWords[];
  stats: Parameters<typeof StatsStrip>[0]["stats"];
  onOpenEntry: (entryId: string) => void;
  onShowTimeline: () => void;
}

export function OverviewView({
  entries,
  activity,
  monthly,
  stats,
  onOpenEntry,
  onShowTimeline,
}: OverviewViewProps) {
  const latestMonth = monthly.at(-1);

  return (
    <>
      <StatsStrip stats={stats} />
      <div className="overview-layout">
        <section className="recent-section">
          <div className="section-heading">
            <div>
              <span>RECENT MEMORIES</span>
              <h2>最近的日子</h2>
            </div>
            <button className="text-button" type="button" onClick={onShowTimeline}>
              全部日記
              <ArrowUpRight aria-hidden="true" size={16} />
            </button>
          </div>
          {entries.length > 0 ? (
            <div className="entry-grid">
              {entries.slice(0, 5).map((entry) => (
                <EntryCard entry={entry} key={entry.id} onOpen={onOpenEntry} />
              ))}
            </div>
          ) : (
            <EmptyState title="沒有符合的日記" />
          )}
        </section>

        <aside className="insight-rail">
          <ActivityHeatmap activity={activity} />

          <section className="month-note">
            <span>THIS MONTH</span>
            <strong>{latestMonth ? formatNumber(latestMonth.words) : "0"}</strong>
            <p>字 · {latestMonth ? latestMonth.entries : 0} 篇日記</p>
          </section>

          <section className="prompt-note">
            <PenLine aria-hidden="true" size={20} />
            <span>今日一問</span>
            <p>最近有哪個很小的瞬間，讓你突然覺得生活很好？</p>
          </section>
        </aside>
      </div>
    </>
  );
}

export function TimelineView({
  entries,
  onOpenEntry,
}: {
  entries: TimelineEntry[];
  onOpenEntry: (entryId: string) => void;
}) {
  return (
    <section className="view-section">
      <div className="section-heading">
        <div>
          <span>ALL ENTRIES</span>
          <h2>{entries.length} 篇日記</h2>
        </div>
      </div>
      {entries.length > 0 ? (
        <div className="entry-grid entry-grid--timeline">
          {entries.map((entry) => (
            <EntryCard entry={entry} key={entry.id} onOpen={onOpenEntry} />
          ))}
        </div>
      ) : (
        <EmptyState title="沒有符合的日記" />
      )}
    </section>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="empty-state">
      <PenLine aria-hidden="true" size={26} />
      <strong>{title}</strong>
    </div>
  );
}

export function CalendarView({ activity }: { activity: ActivityDay[] }) {
  const activityMap = new Map(activity.map((day) => [day.date, day]));
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > daysInMonth) return null;
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return { day, key, activity: activityMap.get(key) };
  });

  return (
    <section className="view-section calendar-view">
      <div className="section-heading">
        <div>
          <span>CALENDAR</span>
          <h2>{formatMonth(`${year}-${String(month + 1).padStart(2, "0")}`)}</h2>
        </div>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">
        {['日', '一', '二', '三', '四', '五', '六'].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-grid">
        {cells.map((cell, index) => (
          <div className="calendar-cell" data-has-entry={Boolean(cell?.activity)} key={cell?.key ?? `empty-${index}`}>
            {cell ? (
              <>
                <span>{cell.day}</span>
                {cell.activity ? (
                  <strong>{cell.activity.entries} 篇</strong>
                ) : null}
              </>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function PlacesView({ entries }: { entries: TimelineEntry[] }) {
  const places = entries.filter((entry) => entry.location);

  return (
    <section className="view-section places-view">
      <div className="section-heading">
        <div>
          <span>PLACES</span>
          <h2>記憶發生的地方</h2>
        </div>
      </div>
      <div className="place-list">
        {places.map((entry, index) => (
          <article className="place-row" key={entry.id}>
            <span className="place-row__number">{String(index + 1).padStart(2, "0")}</span>
            <div className="place-row__pin">
              <MapPin aria-hidden="true" size={18} />
            </div>
            <div>
              <strong>{entry.location}</strong>
              <span>{entry.title}</span>
            </div>
            <time>{entry.localDate.replaceAll("-", ".")}</time>
          </article>
        ))}
      </div>
    </section>
  );
}

export function InsightsView({
  monthly,
  activity,
}: {
  monthly: MonthlyWords[];
  activity: ActivityDay[];
}) {
  const maxWords = Math.max(...monthly.map((month) => month.words), 1);
  const average = activity.length
    ? Math.round(activity.reduce((sum, day) => sum + day.words, 0) / activity.length)
    : 0;

  return (
    <section className="view-section insights-view">
      <div className="section-heading">
        <div>
          <span>INSIGHTS</span>
          <h2>寫作的軌跡</h2>
        </div>
      </div>
      <div className="insight-summary">
        <div>
          <span>平均每次</span>
          <strong>{formatNumber(average)}</strong>
          <small>字</small>
        </div>
        <div>
          <span>最常記錄</span>
          <strong>夜晚</strong>
          <small>20:00–24:00</small>
        </div>
        <div>
          <span>有地點</span>
          <strong>{formatNumber(activity.length)}</strong>
          <small>個日子</small>
        </div>
      </div>
      <div className="monthly-chart" aria-label="每月字數">
        {monthly.map((month) => (
          <div className="monthly-bar" key={month.month}>
            <div>
              <span style={{ height: `${Math.max(8, (month.words / maxWords) * 100)}%` }} />
            </div>
            <strong>{month.month.slice(5)} 月</strong>
            <small>{formatNumber(month.words)}</small>
          </div>
        ))}
      </div>
      <ActivityHeatmap activity={activity} />
    </section>
  );
}
