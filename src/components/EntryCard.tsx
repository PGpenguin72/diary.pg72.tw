import { Clock3, Heart, MapPin } from "lucide-react";
import type { TimelineEntry } from "../../shared/api";
import { formatEntryDate, formatEntryTime } from "../lib/format";

interface EntryCardProps {
  entry: TimelineEntry;
  onOpen: (entryId: string) => void;
}

export function EntryCard({ entry, onOpen }: EntryCardProps) {
  const cover = entry.media[0];
  const isWide = entry.layoutPreset === "film" || (entry.layoutPreset === "auto" && Boolean(cover));

  return (
    <article
      className="entry-card"
      data-layout={entry.layoutPreset}
      data-wide={isWide}
      style={{ "--journal-color": entry.journalColor } as React.CSSProperties}
    >
      <button
        className="entry-card__open"
        type="button"
        aria-label={`閱讀「${entry.title}」`}
        onClick={() => onOpen(entry.id)}
      />

      {cover ? (
        <figure className="entry-card__media">
          <img
            src={cover.src}
            alt={cover.alt}
            width={cover.width ?? 1200}
            height={cover.height ?? 800}
            loading="lazy"
          />
          {cover.caption ? <figcaption>{cover.caption}</figcaption> : null}
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
