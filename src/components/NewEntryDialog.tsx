import { LoaderCircle, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { CreateEntryInput } from "../../shared/api";

interface NewEntryDialogProps {
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: CreateEntryInput) => Promise<void>;
}

function localDateTimeValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

export function NewEntryDialog({ saving, error, onClose, onSave }: NewEntryDialogProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [location, setLocation] = useState("");
  const [mood, setMood] = useState("");
  const [dateTime, setDateTime] = useState(localDateTimeValue);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const localDate = dateTime.slice(0, 10);

    await onSave({
      title,
      body,
      occurredAt: new Date(dateTime).toISOString(),
      timezone: "Asia/Taipei",
      localDate,
      location: location.trim() || null,
      mood: mood || null,
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="compose-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span>NEW ENTRY</span>
            <h2 id="compose-title">寫下今天</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} title="關閉">
            <X aria-hidden="true" size={20} />
            <span className="sr-only">關閉</span>
          </button>
        </header>

        <form className="compose-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span>標題</span>
            <input
              autoFocus
              required
              maxLength={180}
              value={title}
              placeholder="今天想記住什麼？"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="compose-form__body">
            <span>內容</span>
            <textarea
              required
              maxLength={100_000}
              value={body}
              placeholder="開始寫日記..."
              onChange={(event) => setBody(event.target.value)}
            />
          </label>

          <div className="compose-form__row">
            <label>
              <span>日期</span>
              <input
                required
                type="datetime-local"
                value={dateTime}
                onChange={(event) => setDateTime(event.target.value)}
              />
            </label>
            <label>
              <span>心情</span>
              <select value={mood} onChange={(event) => setMood(event.target.value)}>
                <option value="">未設定</option>
                <option value="calm">平靜</option>
                <option value="grateful">感謝</option>
                <option value="focused">專注</option>
                <option value="tired">疲倦</option>
                <option value="hopeful">期待</option>
              </select>
            </label>
          </div>

          <label>
            <span>地點</span>
            <input
              maxLength={180}
              value={location}
              placeholder="選填"
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <footer className="dialog-actions">
            <button className="button button--ghost" type="button" onClick={onClose}>
              取消
            </button>
            <button className="button button--primary" type="submit" disabled={saving}>
              {saving ? <LoaderCircle aria-hidden="true" className="spin" size={17} /> : null}
              <span>{saving ? "儲存中" : "完成"}</span>
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
