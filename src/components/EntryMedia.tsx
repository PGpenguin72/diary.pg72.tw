import { AudioLines } from "lucide-react";
import type { MediaPreview } from "../../shared/api";

export function EntryMedia({
  media,
  interactive = false,
  onIntrinsicSize,
}: {
  media: MediaPreview;
  interactive?: boolean;
  onIntrinsicSize?: (width: number, height: number) => void;
}) {
  if (media.type === "video") {
    return (
      <video
        src={media.src}
        controls={interactive}
        muted={!interactive}
        playsInline
        preload="metadata"
        aria-label={media.alt || media.caption || "日記影片"}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            onIntrinsicSize?.(video.videoWidth, video.videoHeight);
          }
        }}
      />
    );
  }

  if (media.type === "audio") {
    return (
      <div className="entry-audio">
        <AudioLines aria-hidden="true" size={20} />
        <span>{media.caption || "日記錄音"}</span>
        <audio src={media.src} controls preload="metadata" aria-label={media.alt || media.caption || "日記錄音"} />
      </div>
    );
  }

  return (
    <img
      src={media.src}
      alt={media.alt}
      width={media.width ?? 1200}
      height={media.height ?? 800}
      loading={interactive ? "eager" : "lazy"}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          onIntrinsicSize?.(image.naturalWidth, image.naturalHeight);
        }
      }}
    />
  );
}
