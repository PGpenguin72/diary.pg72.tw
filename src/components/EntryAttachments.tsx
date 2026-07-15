import {
  FileAudio,
  FileVideo,
  Image as ImageIcon,
  LoaderCircle,
  PenLine,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { MediaPreview } from "../../shared/api";
import { removeEntryMedia, uploadEntryMedia } from "../lib/api";

type UploadStatus = "waiting" | "uploading" | "done" | "failed";

interface UploadItem {
  key: string;
  file: File;
  status: UploadStatus;
  error: string | null;
  media: MediaPreview | null;
}

interface EntryAttachmentsProps {
  entryId: string;
  initialMedia: MediaPreview[];
  disabled?: boolean;
  onChanged: () => void;
}

const typeLabels: Record<MediaPreview["type"], string> = {
  photo: "相片",
  video: "影片",
  audio: "錄音",
  drawing: "手繪",
};

const statusLabels: Record<UploadStatus, string> = {
  waiting: "等待中",
  uploading: "上傳中",
  done: "已上傳",
  failed: "上傳失敗",
};

function MediaTypeIcon({ type }: { type: MediaPreview["type"] }) {
  if (type === "video") return <FileVideo aria-hidden="true" size={19} />;
  if (type === "audio") return <FileAudio aria-hidden="true" size={19} />;
  if (type === "drawing") return <PenLine aria-hidden="true" size={19} />;
  return <ImageIcon aria-hidden="true" size={19} />;
}

function fileMediaType(file: File): MediaPreview["type"] {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "photo";
}

function AttachmentThumb({ media, type }: { media?: MediaPreview | null; type: MediaPreview["type"] }) {
  if (media && (media.type === "photo" || media.type === "drawing")) {
    return (
      <span className="compose-attachment__thumb">
        <img src={media.src} alt="" loading="lazy" />
      </span>
    );
  }

  return (
    <span className="compose-attachment__thumb">
      <MediaTypeIcon type={type} />
    </span>
  );
}

export function EntryAttachments({ entryId, initialMedia, disabled, onChanged }: EntryAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);
  const [media, setMedia] = useState<MediaPreview[]>(initialMedia);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  // Server appends media positions; this hint keeps the request contract complete.
  const positionRef = useRef(0);
  positionRef.current = media.length + uploads.filter((item) => item.status === "done").length;

  useEffect(() => {
    if (uploads.some((item) => item.status === "uploading")) return;
    const next = uploads.find((item) => item.status === "waiting");
    if (!next) return;

    setUploads((current) =>
      current.map((item) => (item.key === next.key ? { ...item, status: "uploading" as const, error: null } : item)),
    );

    void uploadEntryMedia(entryId, next.file, positionRef.current)
      .then((result) => {
        setUploads((current) =>
          current.map((item) =>
            item.key === next.key ? { ...item, status: "done" as const, media: result.media } : item,
          ),
        );
        onChanged();
      })
      .catch((error: unknown) => {
        setUploads((current) =>
          current.map((item) =>
            item.key === next.key
              ? {
                  ...item,
                  status: "failed" as const,
                  error: error instanceof Error ? error.message : "暫時無法上傳這個檔案。",
                }
              : item,
          ),
        );
      });
  }, [uploads, entryId, onChanged]);

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;

    setUploads((current) => [
      ...current,
      ...files.map((file) => {
        keyCounter.current += 1;
        return {
          key: `upload-${keyCounter.current}`,
          file,
          status: "waiting" as const,
          error: null,
          media: null,
        };
      }),
    ]);
  }

  function retryUpload(key: string) {
    setUploads((current) =>
      current.map((item) => (item.key === key ? { ...item, status: "waiting" as const, error: null } : item)),
    );
  }

  function discardUpload(key: string) {
    setUploads((current) => current.filter((item) => item.key !== key));
  }

  async function removeMedia(mediaId: string) {
    setRemovingId(mediaId);
    setRemoveErrors((current) => {
      if (!(mediaId in current)) return current;
      const rest = { ...current };
      delete rest[mediaId];
      return rest;
    });

    try {
      await removeEntryMedia(entryId, mediaId);
      setMedia((current) => current.filter((item) => item.id !== mediaId));
      setUploads((current) => current.filter((item) => item.media?.id !== mediaId));
      onChanged();
    } catch (error) {
      setRemoveErrors((current) => ({
        ...current,
        [mediaId]: error instanceof Error ? error.message : "暫時無法移除這個附件。",
      }));
    } finally {
      setRemovingId(null);
    }
  }

  const doneCount = uploads.filter((item) => item.status === "done").length;
  const pending = uploads.some((item) => item.status === "waiting" || item.status === "uploading");

  return (
    <section className="compose-attachments" aria-label="附件">
      <div className="compose-attachments__head">
        <span>附件</span>
        <button
          className="button button--secondary button--compact"
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <Plus aria-hidden="true" size={14} />
          加入檔案
        </button>
      </div>

      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={addFiles}
      />

      {uploads.length > 0 ? (
        <p className="compose-attachments__summary" role="status">
          {pending ? (
            <LoaderCircle aria-hidden="true" className="spin" size={13} />
          ) : null}
          已上傳 {doneCount} / {uploads.length} 個檔案
        </p>
      ) : null}

      {media.length === 0 && uploads.length === 0 ? (
        <p className="compose-attachments__empty">目前沒有附件。</p>
      ) : (
        <ul className="compose-attachments__list">
          {media.map((item) => (
            <li key={item.id} className="compose-attachment">
              <AttachmentThumb media={item} type={item.type} />
              <div className="compose-attachment__info">
                <span className="compose-attachment__name">
                  {item.caption || item.alt || typeLabels[item.type]}
                </span>
                <span className="compose-attachment__status">{typeLabels[item.type]}</span>
                {removeErrors[item.id] ? (
                  <span className="compose-attachment__status" data-status="failed">
                    {removeErrors[item.id]}
                  </span>
                ) : null}
              </div>
              <div className="compose-attachment__actions">
                <button
                  className="button button--ghost button--compact"
                  type="button"
                  disabled={disabled || removingId !== null}
                  onClick={() => void removeMedia(item.id)}
                >
                  {removingId === item.id ? (
                    <LoaderCircle aria-hidden="true" className="spin" size={13} />
                  ) : null}
                  {removingId === item.id ? "移除中" : "移除"}
                </button>
              </div>
            </li>
          ))}

          {uploads.map((item) => (
            <li key={item.key} className="compose-attachment" data-upload-status={item.status}>
              <AttachmentThumb media={item.media} type={item.media?.type ?? fileMediaType(item.file)} />
              <div className="compose-attachment__info">
                <span className="compose-attachment__name">{item.file.name}</span>
                <span className="compose-attachment__status" data-status={item.status}>
                  {item.status === "uploading" ? (
                    <LoaderCircle aria-hidden="true" className="spin" size={13} />
                  ) : null}
                  {statusLabels[item.status]}
                  {item.status === "failed" && item.error ? `：${item.error}` : ""}
                </span>
                {item.media && removeErrors[item.media.id] ? (
                  <span className="compose-attachment__status" data-status="failed">
                    {removeErrors[item.media.id]}
                  </span>
                ) : null}
              </div>
              <div className="compose-attachment__actions">
                {item.status === "failed" ? (
                  <button
                    className="button button--secondary button--compact"
                    type="button"
                    disabled={disabled}
                    onClick={() => retryUpload(item.key)}
                  >
                    <RotateCcw aria-hidden="true" size={13} />
                    重試
                  </button>
                ) : null}
                {item.status === "waiting" || item.status === "failed" ? (
                  <button
                    className="icon-button icon-button--compact"
                    type="button"
                    title="取消這個檔案"
                    disabled={disabled}
                    onClick={() => discardUpload(item.key)}
                  >
                    <X aria-hidden="true" size={14} />
                    <span className="sr-only">取消這個檔案</span>
                  </button>
                ) : null}
                {item.status === "done" && item.media ? (
                  <button
                    className="button button--ghost button--compact"
                    type="button"
                    disabled={disabled || removingId !== null}
                    onClick={() => void removeMedia(item.media!.id)}
                  >
                    {removingId === item.media.id ? (
                      <LoaderCircle aria-hidden="true" className="spin" size={13} />
                    ) : null}
                    {removingId === item.media.id ? "移除中" : "移除"}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
