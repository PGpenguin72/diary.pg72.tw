import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MediaPreview } from "../../shared/api";

interface MediaLightboxProps {
  images: MediaPreview[];
  activeIndex: number;
  onChange: (index: number) => void;
  onClose: () => void;
}

export function MediaLightbox({ images, activeIndex, onChange, onClose }: MediaLightboxProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const image = images[activeIndex];

  useEffect(() => {
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && images.length > 1) {
        onChange((activeIndex - 1 + images.length) % images.length);
      }
      if (event.key === "ArrowRight" && images.length > 1) {
        onChange((activeIndex + 1) % images.length);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, images.length, onChange, onClose]);

  if (!image) return null;

  return (
    <div
      className="media-lightbox"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        className="media-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`圖片 ${activeIndex + 1} / ${images.length}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          className="icon-button media-lightbox__close"
          type="button"
          onClick={onClose}
          title="關閉圖片"
        >
          <X aria-hidden="true" size={22} />
          <span className="sr-only">關閉圖片</span>
        </button>

        {images.length > 1 ? (
          <button
            className="icon-button media-lightbox__previous"
            type="button"
            onClick={() => onChange((activeIndex - 1 + images.length) % images.length)}
            title="上一張圖片"
          >
            <ChevronLeft aria-hidden="true" size={24} />
            <span className="sr-only">上一張圖片</span>
          </button>
        ) : null}

        <div className="media-lightbox__frame">
          <img src={image.src} alt={image.alt} loading="eager" />
        </div>

        {images.length > 1 ? (
          <button
            className="icon-button media-lightbox__next"
            type="button"
            onClick={() => onChange((activeIndex + 1) % images.length)}
            title="下一張圖片"
          >
            <ChevronRight aria-hidden="true" size={24} />
            <span className="sr-only">下一張圖片</span>
          </button>
        ) : null}

        <footer className="media-lightbox__caption">
          <span>{image.caption || image.alt || "日記圖片"}</span>
          <small>{activeIndex + 1} / {images.length}</small>
        </footer>
      </section>
    </div>
  );
}
