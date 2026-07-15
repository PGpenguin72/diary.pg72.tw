import { Clock3, Heart, LoaderCircle, MapPin, X } from "lucide-react";
import { useCallback, useState } from "react";
import type { EntryDetail } from "../../shared/api";
import { formatEntryDate, formatEntryTime, formatNumber } from "../lib/format";
import { EntryMarkdown } from "./EntryMarkdown";
import { EntryMedia } from "./EntryMedia";
import { MasonryMediaItem } from "./MasonryMediaItem";
import { MediaLightbox } from "./MediaLightbox";

interface EntryDetailDialogProps {
  entry: EntryDetail | null;
  loading: boolean;
  onClose: () => void;
}

export function EntryDetailDialog({ entry, loading, onClose }: EntryDetailDialogProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const visualMedia = entry?.media.filter((media) => media.type !== "audio") ?? [];
  const audioMedia = entry?.media.filter((media) => media.type === "audio") ?? [];
  const images = visualMedia.filter((media) => media.type === "photo" || media.type === "drawing");
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const changeLightboxImage = useCallback((index: number) => setLightboxIndex(index), []);

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

              <EntryMarkdown blocks={entry.blocks} />

              {entry.media.length > 0 ? (
                <section className="entry-dialog__attachments" aria-label="日記媒體">
                  {visualMedia.length > 0 ? (
                    <div
                      className="entry-dialog__media-grid"
                      data-visual-count={visualMedia.length}
                    >
                      {visualMedia.map((media, index) => {
                        const imageIndex = images.findIndex((image) => image.id === media.id);
                        return (
                          <MasonryMediaItem
                            key={media.id}
                            media={media}
                            index={index}
                            imageIndex={imageIndex}
                            onOpenImage={setLightboxIndex}
                          />
                        );
                      })}
                    </div>
                  ) : null}

                  {audioMedia.length > 0 ? (
                    <div className="entry-dialog__audio-list" aria-label="日記錄音">
                      {audioMedia.map((media) => (
                        <figure key={media.id} data-type={media.type}>
                          <EntryMedia media={media} interactive />
                        </figure>
                      ))}
                    </div>
                  ) : null}
                </section>
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
      {lightboxIndex !== null ? (
        <MediaLightbox
          images={images}
          activeIndex={lightboxIndex}
          onChange={changeLightboxImage}
          onClose={closeLightbox}
        />
      ) : null}
    </div>
  );
}
