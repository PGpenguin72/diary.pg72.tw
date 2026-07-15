import { Clock3, Heart, LoaderCircle, MapPin, X } from "lucide-react";
import type { EntryDetail } from "../../shared/api";
import { formatEntryDate, formatEntryTime, formatNumber } from "../lib/format";
import { EntryMedia } from "./EntryMedia";

interface EntryDetailDialogProps {
  entry: EntryDetail | null;
  loading: boolean;
  onClose: () => void;
}

export function EntryDetailDialog({ entry, loading, onClose }: EntryDetailDialogProps) {
  const visualMediaCount = entry?.media.filter((media) => media.type !== "audio").length ?? 0;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="entry-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={entry?.title ?? "讀取日記"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button dialog-close" type="button" onClick={onClose} title="關閉">
          <X aria-hidden="true" size={20} />
          <span className="sr-only">關閉</span>
        </button>

        {loading || !entry ? (
          <div className="dialog-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={28} />
            <span>讀取中</span>
          </div>
        ) : (
          <>
            <div className="entry-dialog__content">
              <div className="entry-dialog__date">
                <span>{formatEntryDate(entry.occurredAt)}</span>
                <span>{formatEntryTime(entry.occurredAt)}</span>
              </div>
              <h2>{entry.title}</h2>
              <div className="entry-dialog__meta">
                {entry.location ? (
                  <span>
                    <MapPin aria-hidden="true" size={15} />
                    {entry.location}
                  </span>
                ) : null}
                <span>
                  <Clock3 aria-hidden="true" size={15} />
                  {formatNumber(entry.wordCount)} 字
                </span>
                {entry.isFavorite ? (
                  <span>
                    <Heart aria-hidden="true" size={15} fill="currentColor" />
                    收藏
                  </span>
                ) : null}
              </div>

              <div className="entry-prose">
                {entry.blocks.map((block) => {
                  if (!block.text) return null;
                  if (block.type === "quote") return <blockquote key={block.id}>{block.text}</blockquote>;
                  if (block.type === "list") {
                    return (
                      <ul key={block.id}>
                        {block.text.split("\n").map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    );
                  }
                  return <p key={block.id}>{block.text}</p>;
                })}
              </div>

              {entry.media.length > 0 ? (
                <div
                  className="entry-dialog__media-grid"
                  data-visual-count={visualMediaCount}
                  aria-label="日記媒體"
                >
                  {entry.media.map((media) => (
                    <figure key={media.id} data-type={media.type}>
                      <EntryMedia media={media} interactive />
                      {media.caption && media.type !== "audio" ? <figcaption>{media.caption}</figcaption> : null}
                    </figure>
                  ))}
                </div>
              ) : null}

              {entry.tags.length > 0 ? (
                <footer className="entry-dialog__tags">
                  {entry.tags.map((tag) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </footer>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
