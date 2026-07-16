import {
  Archive,
  CheckCircle2,
  Download,
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
  failures: Array<{ item: string; message: string }>;
  unlistedFailures: number;
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
      fileBytesCompleted: number;
      fileBytesTotal: number;
      filePartsCompleted: number;
      filePartsTotal: number;
    }
  | { status: "complete"; file: File; preview: AppleJournalArchivePreview; summary: ImportSummary }
  | { status: "error"; file: File; preview?: AppleJournalArchivePreview; message: string };

function errorMessage(error: unknown): string {
  if (error instanceof AppleJournalArchiveError || error instanceof Error) return error.message;
  return "無法讀取這個 Apple Journal ZIP。";
}

function recordFailure(summary: ImportSummary, item: string, error: unknown): void {
  summary.failed += 1;
  if (summary.failures.length < 100) {
    summary.failures.push({ item, message: errorMessage(error) });
  } else {
    summary.unlistedFailures += 1;
  }
}

function downloadFailureReport(summary: ImportSummary): void {
  const report = JSON.stringify({
    generatedAt: new Date().toISOString(),
    failedCount: summary.failed,
    unlistedFailures: summary.unlistedFailures,
    failures: summary.failures,
  }, null, 2);
  const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "pg72-diary-import-failures.json";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const importAbortRef = useRef<AbortController | null>(null);
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
    const summary: ImportSummary = {
      imported: 0,
      duplicates: 0,
      failed: 0,
      failures: [],
      unlistedFailures: 0,
    };
    const controller = new AbortController();
    importAbortRef.current = controller;

    setState({
      status: "importing",
      file,
      preview,
      completed,
      total,
      label: "建立匯入工作",
      stage: "content",
      fileBytesCompleted: 0,
      fileBytesTotal: 0,
      filePartsCompleted: 0,
      filePartsTotal: 0,
    });

    try {
      const importJob = await startAppleJournalImport({
        fileName: file.name,
        fileFingerprint: preview.fileFingerprint,
        entryCount: preview.entries.length,
        mediaCount: preview.mediaCount,
      }, controller.signal);
      const mediaReader = mediaOperations > 0 ? await createAppleJournalMediaReader(file) : null;

      try {
        for (const entry of preview.entries) {
          controller.signal.throwIfAborted();
          setState({
            status: "importing",
            file,
            preview,
            completed,
            total,
            label: entry.title,
            stage: "content",
            fileBytesCompleted: 0,
            fileBytesTotal: 0,
            filePartsCompleted: 0,
            filePartsTotal: 0,
          });

          let importedEntry: Awaited<ReturnType<typeof importAppleJournalEntry>>;
          try {
            importedEntry = await importAppleJournalEntry(importJob.id, {
              sourcePath: entry.sourcePath,
              mediaCount: entry.media.length,
              title: entry.title,
              body: entry.body,
              occurredAt: entry.occurredAt,
              timezone: entry.timezone,
              localDate: entry.localDate,
              location: entry.location,
              mood: entry.mood,
            }, controller.signal);
            if (importedEntry.disposition === "duplicate") summary.duplicates += 1;
            else summary.imported += 1;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            recordFailure(summary, entry.title, error);
            completed += 1 + entry.media.length;
            continue;
          }

          completed += 1;
          for (const [position, media] of entry.media.entries()) {
            controller.signal.throwIfAborted();
            const mediaLabel = `${entry.title} · 媒體 ${position + 1}/${entry.media.length}`;
            setState({
              status: "importing",
              file,
              preview,
              completed,
              total,
              label: mediaLabel,
              stage: "media",
              fileBytesCompleted: 0,
              fileBytesTotal: media.size,
              filePartsCompleted: 0,
              filePartsTotal: Math.max(1, Math.ceil(media.size / (8 * 1024 * 1024))),
            });

            try {
              if (!mediaReader) throw new Error("媒體讀取器尚未建立。");
              const opened = await mediaReader.open(media, controller.signal);
              const importedMedia = await importAppleJournalMedia(importJob.id, importedEntry.id, {
                stream: opened.stream,
                mimeType: opened.mimeType,
                sizeBytes: opened.sizeBytes,
                fingerprint: media.fingerprint,
                sourcePath: media.archivePath,
                type: media.type,
                position,
                placement: position === 0 ? "cover" : "grid",
                caption: media.caption,
              }, controller.signal, (progress) => {
                setState({
                  status: "importing",
                  file,
                  preview,
                  completed,
                  total,
                  label: mediaLabel,
                  stage: "media",
                  fileBytesCompleted: progress.uploadedBytes,
                  fileBytesTotal: progress.totalBytes,
                  filePartsCompleted: progress.uploadedParts,
                  filePartsTotal: progress.totalParts,
                });
              });
              if (importedMedia.disposition !== "duplicate") {
                await opened.finished;
              }
            } catch (error) {
              if (controller.signal.aborted) throw error;
              recordFailure(summary, mediaLabel, error);
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
      }, controller.signal);
      await onImported();
      setState({ status: "complete", file, preview, summary });
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ status: "ready", file, preview });
      } else {
        setState({ status: "error", file, preview, message: errorMessage(error) });
      }
    } finally {
      if (importAbortRef.current === controller) importAbortRef.current = null;
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
              <div
                className="import-progress"
                role="progressbar"
                aria-label="整體匯入進度"
                aria-valuemin={0}
                aria-valuemax={state.total}
                aria-valuenow={state.completed}
                aria-valuetext={`${state.completed} / ${state.total}`}
              >
                <span style={{ width: `${state.total ? (state.completed / state.total) * 100 : 0}%` }} />
              </div>
              <small>{state.completed} / {state.total}</small>
              {state.stage === "media" ? (
                <div className="import-file-progress">
                  <div
                    className="import-progress import-progress--file"
                    role="progressbar"
                    aria-label="目前媒體上傳進度"
                    aria-valuemin={0}
                    aria-valuemax={state.fileBytesTotal}
                    aria-valuenow={state.fileBytesCompleted}
                    aria-valuetext={`${formatBytes(state.fileBytesCompleted)} / ${formatBytes(state.fileBytesTotal)}，${state.filePartsCompleted} / ${state.filePartsTotal} 個分段`}
                  >
                    <span
                      style={{
                        width: `${state.fileBytesTotal ? (state.fileBytesCompleted / state.fileBytesTotal) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <small>
                    {formatBytes(state.fileBytesCompleted)} / {formatBytes(state.fileBytesTotal)} · {state.filePartsCompleted} / {state.filePartsTotal} 段
                  </small>
                </div>
              ) : null}
              <p className="sr-only" role="status" aria-live="polite">
                {state.label}，整體 {state.completed} / {state.total}
              </p>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => importAbortRef.current?.abort()}
              >
                取消匯入
              </button>
            </>
          ) : null}

          {state.status === "complete" ? (
            <>
              {state.summary.failed ? (
                <FileWarning aria-hidden="true" size={32} />
              ) : (
                <CheckCircle2 aria-hidden="true" size={32} />
              )}
              <strong>{state.summary.failed ? "部分附件尚未完成" : "匯入完成"}</strong>
              <span>
                {state.summary.imported} 篇已寫入 · {state.summary.duplicates} 篇重複
                {state.summary.failed ? ` · ${state.summary.failed} 個失敗` : ""}
              </span>
              <small>
                {state.summary.failed
                  ? "重新選擇同一份 ZIP 即可從未完成處繼續。"
                  : "總覽與統計已更新"}
              </small>
              {state.summary.failures.length ? (
                <ul className="import-failures" aria-label="匯入失敗項目">
                  {state.summary.failures.slice(0, 5).map((failure, index) => (
                    <li key={`${failure.item}-${index}`}>
                      <strong>{failure.item}</strong>
                      <span>{failure.message}</span>
                    </li>
                  ))}
                  {state.summary.failed > 5 ? (
                    <li>另有 {state.summary.failed - 5} 個失敗項目，請下載完整報告。</li>
                  ) : null}
                </ul>
              ) : null}
              <div className="import-actions">
                {state.summary.failed ? (
                  <>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => downloadFailureReport(state.summary)}
                    >
                      <Download aria-hidden="true" size={16} />
                      下載失敗報告
                    </button>
                    <button
                      className="button button--secondary"
                      type="button"
                      onClick={() => void runImport(state.file, state.preview)}
                    >
                      重試未完成項目
                    </button>
                  </>
                ) : null}
                <button className="button button--primary" type="button" onClick={onClose}>
                  完成
                </button>
              </div>
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
