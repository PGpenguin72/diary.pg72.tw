import { AudioLines } from "lucide-react";
import type { MediaPreview } from "../../shared/api";

export function EntryMedia({
  media,
  interactive = false,
}: {
  media: MediaPreview;
  interactive?: boolean;
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
    />
  );
}
