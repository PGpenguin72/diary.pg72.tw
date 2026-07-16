import { LogIn, LogOut, Plus, Search, Upload, X } from "lucide-react";
import { useId } from "react";
import { getTodayLabel } from "../lib/format";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  searchQuery: string;
  canWrite: boolean;
  showLogin: boolean;
  showLogout: boolean;
  loggingOut: boolean;
  onChangeSearch: (query: string) => void;
  onNewEntry: () => void;
  onImport: () => void;
  onLogin: () => void;
  onLogout: () => void;
}

export function PageHeader({
  eyebrow,
  title,
  searchQuery,
  canWrite,
  showLogin,
  showLogout,
  loggingOut,
  onChangeSearch,
  onNewEntry,
  onImport,
  onLogin,
  onLogout,
}: PageHeaderProps) {
  const searchId = useId();

  return (
    <header className="page-header">
      <div className="page-header__title">
        <strong className="mobile-brand">PG72 Diary</strong>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{getTodayLabel()}</p>
      </div>

      <div className="page-actions">
        <label className="search-field" htmlFor={searchId}>
          <Search aria-hidden="true" size={18} />
          <input
            id={searchId}
            type="search"
            value={searchQuery}
            placeholder="搜尋日記"
            onChange={(event) => onChangeSearch(event.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              title="清除搜尋"
              aria-label="清除搜尋"
              onClick={() => onChangeSearch("")}
            >
              <X aria-hidden="true" size={16} />
            </button>
          ) : null}
        </label>

        {canWrite ? (
          <>
            <button
              className="button button--secondary"
              type="button"
              aria-label="匯入"
              title="匯入"
              onClick={onImport}
            >
              <Upload aria-hidden="true" size={17} />
              <span>匯入</span>
            </button>
            <button
              className="button button--primary"
              type="button"
              aria-label="新增日記"
              title="新增日記"
              onClick={onNewEntry}
            >
              <Plus aria-hidden="true" size={18} />
              <span>新增日記</span>
            </button>
          </>
        ) : null}

        {showLogin ? (
          <button
            className="button button--secondary"
            type="button"
            aria-label="登入"
            title="登入"
            onClick={onLogin}
          >
            <LogIn aria-hidden="true" size={17} />
            <span>登入</span>
          </button>
        ) : null}

        {showLogout ? (
          <button
            className="button button--secondary"
            type="button"
            aria-label="登出"
            title="登出"
            disabled={loggingOut}
            onClick={onLogout}
          >
            <LogOut aria-hidden="true" size={17} />
            <span>登出</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}
