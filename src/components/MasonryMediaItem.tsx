import { ZoomIn } from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { MediaPreview } from "../../shared/api";
import { EntryMedia } from "./EntryMedia";

const masonryRowHeight = 4;
const masonryGap = 12;

function updateMasonrySpan(figure: HTMLElement) {
  const height = figure.getBoundingClientRect().height;
  const span = Math.max(1, Math.ceil((height + masonryGap) / masonryRowHeight));
  figure.style.setProperty("--masonry-row-span", String(span));
}

interface MasonryMediaItemProps {
  media: MediaPreview;
  index: number;
  imageIndex: number;
  onOpenImage: (index: number) => void;
}

export function MasonryMediaItem({ media, index, imageIndex, onOpenImage }: MasonryMediaItemProps) {
  const figureRef = useRef<HTMLElement>(null);
  const isImage = imageIndex >= 0;

  useLayoutEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;

    const observer = new ResizeObserver(() => updateMasonrySpan(figure));
    observer.observe(figure);
    updateMasonrySpan(figure);
    return () => observer.disconnect();
  }, []);

  return (
    <figure
      ref={figureRef}
      data-type={media.type}
      style={{ "--masonry-column": index % 2 + 1 } as CSSProperties}
    >
      {isImage ? (
        <button
          className="entry-dialog__media-zoom"
          type="button"
          onClick={() => onOpenImage(imageIndex)}
          aria-label={`放大圖片 ${imageIndex + 1}`}
        >
          <EntryMedia media={media} />
          <span aria-hidden="true"><ZoomIn size={17} /></span>
        </button>
      ) : (
        <EntryMedia media={media} interactive />
      )}
      {media.caption ? <figcaption>{media.caption}</figcaption> : null}
    </figure>
  );
}
