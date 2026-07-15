import { ChevronLeft, ChevronRight, Clock3, Heart, MapPin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TimelineEntry } from "../../shared/api";
import { formatEntryDate, formatEntryTime } from "../lib/format";
import { EntryMedia } from "./EntryMedia";

interface EntryCardProps {
  entry: TimelineEntry;
  onOpen: (entryId: string) => void;
}

function mediaAspectRatio(media: TimelineEntry["media"][number] | undefined): number | null {
  if (!media?.width || !media.height || media.width <= 0 || media.height <= 0) return null;
  return media.width / media.height;
}

export function EntryCard({ entry, onOpen }: EntryCardProps) {
  const covers = useMemo(() => {
    const images = entry.media.filter((media) => media.type === "photo" || media.type === "drawing");
    return images.length > 0 ? images : entry.media.filter((media) => media.type === "video");
  }, [entry.media]);
  const firstCover = covers[0];
  const [coverIndex, setCoverIndex] = useState(0);
  const [coverAspectRatio, setCoverAspectRatio] = useState(() => mediaAspectRatio(firstCover));
  const cover = covers[coverIndex % Math.max(covers.length, 1)];
  const isWide = entry.layoutPreset === "film" || (entry.layoutPreset === "auto" && Boolean(cover));

  useEffect(() => {
    if (covers.length <= 1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const interval = window.setInterval(
      () => setCoverIndex((current) => (current + 1) % covers.length),
      6_000 + (Math.abs(entry.layoutSeed) % 4) * 700,
    );
    return () => window.clearInterval(interval);
  }, [covers.length, entry.layoutSeed]);

  function rotateCover(direction: -1 | 1) {
    setCoverIndex((current) => (current + direction + covers.length) % covers.length);
  }

  return (
    <article
      className="entry-card"
      data-layout={entry.layoutPreset}
      data-wide={isWide}
      style={{
        "--journal-color": entry.journalColor,
        "--cover-aspect-ratio": coverAspectRatio ?? "4 / 3",
      } as React.CSSProperties}
    >
      <button
        className="entry-card__open"
        type="button"
        aria-label={`閱讀「${entry.title}」`}
        onClick={() => onOpen(entry.id)}
      />

      {cover ? (
        <figure className="entry-card__media">
          <div className="entry-card__media-frame" key={cover.id}>
            <EntryMedia
              media={cover}
              onIntrinsicSize={cover.id === firstCover?.id
                ? (width, height) => setCoverAspectRatio(width / height)
                : undefined}
            />
          </div>
          {cover.caption ? <figcaption>{cover.caption}</figcaption> : null}
          {covers.length > 1 ? (
            <div className="entry-card__cover-controls" aria-label="封面圖片">
              <button type="button" onClick={() => rotateCover(-1)} title="上一張封面" aria-label="上一張封面">
                <ChevronLeft aria-hidden="true" size={15} />
              </button>
              <span>{coverIndex % covers.length + 1} / {covers.length}</span>
              <button type="button" onClick={() => rotateCover(1)} title="下一張封面" aria-label="下一張封面">
                <ChevronRight aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}
        </figure>
      ) : null}

      <div className="entry-card__body">
        <div className="entry-card__date">
          <span>{formatEntryDate(entry.occurredAt)}</span>
          {entry.isFavorite ? <Heart aria-label="收藏" size={16} fill="currentColor" /> : null}
        </div>
        <h3>{entry.title}</h3>
        <p>{entry.excerpt}</p>

        <div className="entry-card__meta">
          <span>
            <Clock3 aria-hidden="true" size={14} />
            {formatEntryTime(entry.occurredAt)}
          </span>
          {entry.location ? (
            <span>
              <MapPin aria-hidden="true" size={14} />
              {entry.location}
            </span>
          ) : null}
        </div>

        {entry.tags.length > 0 ? (
          <div className="entry-card__tags" aria-label="標籤">
            {entry.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}
