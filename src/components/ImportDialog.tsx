import {
  Archive,
  CheckCircle2,
  FileWarning,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  completeAppleJournalImport,
  importAppleJournalEntry,
  importAppleJournalMedia,
  startAppleJournalImport,
} from "../lib/api";
import {
  AppleJournalArchiveError,
  createAppleJournalMediaReader,
  inspectAppleJournalArchive,
  type AppleJournalArchivePreview,
} from "../lib/apple-journal";
import { formatBytes } from "../lib/format";

interface ImportSummary {
  imported: number;
  duplicates: number;
  failed: number;
}

type ImportState =
  | { status: "idle" }
  | { status: "inspecting"; file: File }
  | { status: "ready"; file: File; preview: AppleJournalArchivePreview }
  | {
      status: "importing";
      file: File;
      preview: AppleJournalArchivePreview;
      completed: number;
      total: number;
      label: string;
      stage: "content" | "media";
    }
  | { status: "complete"; file: File; preview: AppleJournalArchivePreview; summary: ImportSummary }
  | { status: "error"; file: File; preview?: AppleJournalArchivePreview; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof AppleJournalArchiveError || error instanceof Error) return error.message;
  return "無法讀取這個 Apple Journal ZIP。";
}

export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const isImporting = state.status === "importing";

  async function inspect(file: File) {
    setState({ status: "inspecting", file });

    try {
      const preview = await inspectAppleJournalArchive(file);
      setState({ status: "ready", file, preview });
    } catch (error) {
      setState({ status: "error", file, message: errorMessage(error) });
    }
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void inspect(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (isImporting) return;
    const file = event.dataTransfer.files[0];
    if (file) void inspect(file);
  }

  async function runImport(file: File, preview: AppleJournalArchivePreview) {
    const mediaOperations = preview.entries.reduce((total, entry) => total + entry.media.length, 0);
    const total = preview.entries.length + mediaOperations;
    let completed = 0;
    const summary: ImportSummary = { imported: 0, duplicates: 0, failed: 0 };

    setState({
      status: "importing",
      file,
      preview,
      completed,
      total,
      label: "建立匯入工作",
      stage: "content",
    });

    try {
      const importJob = await startAppleJournalImport({
        fileName: file.name,
        fileFingerprint: preview.fileFingerprint,
        entryCount: preview.entries.length,
        mediaCount: preview.mediaCount,
      });
      const mediaReader = mediaOperations > 0 ? await createAppleJournalMediaReader(file) : null;

      try {
        for (const entry of preview.entries) {
          setState({
            status: "importing",
            file,
            preview,
            completed,
            total,
            label: entry.title,
            stage: "content",
          });

          let importedEntry: Awaited<ReturnType<typeof importAppleJournalEntry>>;
          try {
            importedEntry = await importAppleJournalEntry(importJob.id, {
              sourcePath: entry.sourcePath,
              title: entry.title,
              body: entry.body,
              occurredAt: entry.occurredAt,
              timezone: entry.timezone,
              localDate: entry.localDate,
              location: entry.location,
              mood: entry.mood,
            });
            if (importedEntry.disposition === "duplicate") summary.duplicates += 1;
            else summary.imported += 1;
          } catch {
            summary.failed += 1;
            completed += 1 + entry.media.length;
            continue;
          }

          completed += 1;
          for (const [position, media] of entry.media.entries()) {
            setState({
              status: "importing",
              file,
              preview,
              completed,
              total,
              label: `${entry.title} · 媒體 ${position + 1}/${entry.media.length}`,
              stage: "media",
            });

            try {
              if (!mediaReader) throw new Error("媒體讀取器尚未建立。");
              const blob = await mediaReader.read(media);
              await importAppleJournalMedia(importJob.id, importedEntry.id, {
                blob,
                fingerprint: media.fingerprint,
                sourcePath: media.archivePath,
                type: media.type,
                position,
                placement: position === 0 ? "cover" : "grid",
                caption: media.caption,
              });
            } catch {
              summary.failed += 1;
            }
            completed += 1;
          }
        }
      } finally {
        await mediaReader?.close();
      }

      await completeAppleJournalImport(importJob.id, {
        insertedCount: summary.imported,
        duplicateCount: summary.duplicates,
        skippedCount: 0,
        failedCount: summary.failed,
      });
      await onImported();
      setState({ status: "complete", file, preview, summary });
    } catch (error) {
      setState({ status: "error", file, preview, message: errorMessage(error) });
    }
  }

  const preview = "preview" in state ? state.preview : undefined;
  const step = state.status === "complete" ? 4 : state.status === "importing" ? (state.stage === "media" ? 3 : 2) : preview ? 2 : state.status === "idle" ? 0 : 1;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!isImporting) onClose();
      }}
    >
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        aria-busy={isImporting}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span>APPLE JOURNAL</span>
            <h2 id="import-title">匯入日記</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            title="關閉"
            disabled={isImporting}
          >
            <X aria-hidden="true" size={20} />
            <span className="sr-only">關閉</span>
          </button>
        </header>

        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".zip,application/zip"
          onChange={handleInput}
        />

        <div
          className="import-dropzone"
          data-state={state.status}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          {state.status === "idle" ? (
            <>
              <Upload aria-hidden="true" size={28} strokeWidth={1.6} />
              <strong>AppleJournalEntries ZIP</strong>
              <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()}>
                選擇檔案
              </button>
            </>
          ) : null}

          {state.status === "inspecting" ? (
            <>
              <LoaderCircle aria-hidden="true" className="spin" size={28} />
              <strong>正在解析 {state.file.name}</strong>
              <small>檢查日記內容與媒體關聯</small>
            </>
          ) : null}

          {state.status === "ready" ? (
            <>
              <Archive aria-hidden="true" size={30} />
              <strong>{state.preview.entries.length} 篇日記可以匯入</strong>
              <span>{state.preview.mediaCount} 個媒體 · {formatBytes(state.preview.mediaBytes)}</span>
              <small>{state.file.name} · {formatBytes(state.file.size)}</small>
              <div className="import-actions">
                <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()}>
                  更換檔案
                </button>
                <button className="button button--primary" type="button" onClick={() => void runImport(state.file, state.preview)}>
                  開始匯入
                </button>
              </div>
            </>
          ) : null}

          {state.status === "importing" ? (
            <>
              <LoaderCircle aria-hidden="true" className="spin" size={30} />
              <strong>{state.stage === "media" ? "正在儲存媒體" : "正在匯入日記"}</strong>
              <span>{state.label}</span>
              <div className="import-progress" aria-label={`匯入進度 ${state.completed}/${state.total}`}>
                <span style={{ width: `${state.total ? (state.completed / state.total) * 100 : 0}%` }} />
              </div>
              <small>{state.completed} / {state.total}</small>
            </>
          ) : null}

          {state.status === "complete" ? (
            <>
              <CheckCircle2 aria-hidden="true" size={32} />
              <strong>匯入完成</strong>
              <span>
                {state.summary.imported} 篇已寫入 · {state.summary.duplicates} 篇重複
                {state.summary.failed ? ` · ${state.summary.failed} 個失敗` : ""}
              </span>
              <small>總覽與統計已更新</small>
              <button className="button button--primary" type="button" onClick={onClose}>
                完成
              </button>
            </>
          ) : null}

          {state.status === "error" ? (
            <>
              <FileWarning aria-hidden="true" size={30} />
              <strong>{state.message}</strong>
              <span>{state.file.name}</span>
              <div className="import-actions">
                <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()}>
                  更換檔案
                </button>
                {state.preview ? (
                  <button className="button button--primary" type="button" onClick={() => void runImport(state.file, state.preview!)}>
                    再試一次
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <ol className="import-steps" aria-label="匯入進度">
          {([
            [1, "檔案"],
            [2, "內容"],
            [3, "媒體"],
            [4, "完成"],
          ] as const).map(([number, label]) => (
            <li key={label} data-active={step >= number} data-complete={step > number}>
              {label}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
