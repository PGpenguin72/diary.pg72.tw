import { Archive, CheckCircle2, FileWarning, Upload, X } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { formatBytes } from "../lib/format";

type InspectionState =
  | { status: "idle" }
  | { status: "checking"; file: File }
  | { status: "valid"; file: File }
  | { status: "invalid"; file: File; message: string };

async function hasZipSignature(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]);
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inspection, setInspection] = useState<InspectionState>({ status: "idle" });

  async function inspect(file: File) {
    setInspection({ status: "checking", file });

    if (!file.name.toLowerCase().endsWith(".zip")) {
      setInspection({ status: "invalid", file, message: "請選擇 AppleJournalEntries ZIP。" });
      return;
    }

    if (file.size === 0) {
      setInspection({ status: "invalid", file, message: "這個 ZIP 沒有內容。" });
      return;
    }

    if (!(await hasZipSignature(file))) {
      setInspection({ status: "invalid", file, message: "檔案不是有效的 ZIP。" });
      return;
    }

    setInspection({ status: "valid", file });
  }

  function handleInput(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void inspect(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void inspect(file);
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span>APPLE JOURNAL</span>
            <h2 id="import-title">匯入日記</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="關閉">
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
          data-state={inspection.status}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          {inspection.status === "idle" ? (
            <>
              <Upload aria-hidden="true" size={28} strokeWidth={1.6} />
              <strong>AppleJournalEntries ZIP</strong>
              <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()}>
                選擇檔案
              </button>
            </>
          ) : null}

          {inspection.status === "checking" ? (
            <>
              <Archive aria-hidden="true" size={28} />
              <strong>正在檢查 {inspection.file.name}</strong>
            </>
          ) : null}

          {inspection.status === "valid" ? (
            <>
              <CheckCircle2 aria-hidden="true" size={30} />
              <strong>基本格式檢查完成</strong>
              <span>{inspection.file.name}</span>
              <small>{formatBytes(inspection.file.size)} · 尚未寫入日記</small>
              <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()}>
                更換檔案
              </button>
            </>
          ) : null}

          {inspection.status === "invalid" ? (
            <>
              <FileWarning aria-hidden="true" size={30} />
              <strong>{inspection.message}</strong>
              <span>{inspection.file.name}</span>
              <button className="button button--secondary" type="button" onClick={() => inputRef.current?.click()}>
                重新選擇
              </button>
            </>
          ) : null}
        </div>

        <ol className="import-steps" aria-label="匯入進度">
          <li data-active={inspection.status !== "idle"}>檔案</li>
          <li>內容</li>
          <li>媒體</li>
          <li>完成</li>
        </ol>
      </section>
    </div>
  );
}
