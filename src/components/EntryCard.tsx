import { Clock3, Heart, MapPin } from "lucide-react";
import type { TimelineEntry } from "../../shared/api";
import { formatEntryDate, formatEntryTime } from "../lib/format";
import { EntryMedia } from "./EntryMedia";

interface EntryCardProps {
  entry: TimelineEntry;
  onOpen: (entryId: string) => void;
}

export function EntryCard({ entry, onOpen }: EntryCardProps) {
  const visualMedia = entry.media.filter((media) => media.type !== "audio");
  const previewMedia = visualMedia.slice(0, 6);
  const remainingMedia = visualMedia.length - previewMedia.length;
  const isWide = entry.layoutPreset === "film" || visualMedia.length >= 3;

  return (
    <article
      className="entry-card"
      data-layout={entry.layoutPreset}
      data-wide={isWide}
      data-has-media={previewMedia.length > 0}
      style={{ "--journal-color": entry.journalColor } as React.CSSProperties}
    >
      <button
        className="entry-card__open"
        type="button"
        aria-label={`閱讀「${entry.title}」`}
        onClick={() => onOpen(entry.id)}
      />

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

      {previewMedia.length > 0 ? (
        <div
          className="entry-card__gallery"
          data-count={previewMedia.length}
          aria-label={`日記媒體，共 ${visualMedia.length} 個`}
        >
          {previewMedia.map((media, index) => (
            <figure key={media.id} data-type={media.type}>
              <EntryMedia media={media} />
              {index === previewMedia.length - 1 && remainingMedia > 0 ? (
                <span className="entry-card__gallery-more">+{remainingMedia}</span>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}
    </article>
  );
}
