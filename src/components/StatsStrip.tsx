import { Camera, Flame, NotebookPen, Type } from "lucide-react";
import type { OverviewResponse } from "../../shared/api";
import { formatCompactNumber, formatNumber } from "../lib/format";

interface StatsStripProps {
  stats: OverviewResponse["stats"];
}

export function StatsStrip({ stats }: StatsStripProps) {
  const items = [
    {
      label: "日記",
      value: formatNumber(stats.totalEntries),
      detail: `${formatNumber(stats.totalDays)} 個日子`,
      icon: NotebookPen,
      tone: "mint",
    },
    {
      label: "總字數",
      value: formatCompactNumber(stats.totalWords),
      detail: "持續累積中",
      icon: Type,
      tone: "sky",
    },
    {
      label: "目前連續",
      value: `${formatNumber(stats.currentStreak)} 天`,
      detail: `最長 ${formatNumber(stats.longestStreak)} 天`,
      icon: Flame,
      tone: "coral",
    },
    {
      label: "媒體",
      value: formatNumber(stats.photoCount + stats.videoCount + stats.audioCount),
      detail: `${formatNumber(stats.photoCount)} 張照片`,
      icon: Camera,
      tone: "gold",
    },
  ];

  return (
    <section className="stats-strip" aria-label="日記統計">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div className="stat" data-tone={item.tone} key={item.label}>
            <div className="stat__icon" aria-hidden="true">
              <Icon size={19} strokeWidth={1.8} />
            </div>
            <div>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </div>
          </div>
        );
      })}
    </section>
  );
}
