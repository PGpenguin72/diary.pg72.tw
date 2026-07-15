import { AlertCircle, LoaderCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { EntryDetail, OverviewResponse, SessionResponse, TimelineEntry } from "../shared/api";
import { AppShell, type AppView } from "./components/AppShell";
import { NewEntryDialog } from "./components/NewEntryDialog";
import { PageHeader } from "./components/PageHeader";
import {
  CalendarView,
  InsightsView,
  OverviewView,
  PlacesView,
  TimelineView,
} from "./components/Views";
import {
  ApiRequestError,
  createEntry,
  getEntry,
  getOverview,
  getSession,
  getTimeline,
  logout,
} from "./lib/api";
import { clearAuthErrorParams, readAuthErrorNotice } from "./lib/auth-notice";

const ImportDialog = lazy(async () => {
  const module = await import("./components/ImportDialog");
  return { default: module.ImportDialog };
});

const EntryDetailDialog = lazy(async () => {
  const module = await import("./components/EntryDetailDialog");
  return { default: module.EntryDetailDialog };
});

interface AppData {
  overview: OverviewResponse;
  entries: TimelineEntry[];
}

async function fetchAppData(): Promise<AppData> {
  const [overview, timeline] = await Promise.all([getOverview(), getTimeline()]);
  return { overview, entries: timeline.entries };
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

const viewTitles: Record<AppView, { eyebrow: string; title: string }> = {
  overview: { eyebrow: "WELCOME BACK", title: "回來看看這些日子" },
  timeline: { eyebrow: "TIMELINE", title: "時間留下的順序" },
  calendar: { eyebrow: "CALENDAR", title: "日子慢慢成為生活" },
  places: { eyebrow: "PLACES", title: "走過的地方" },
  insights: { eyebrow: "INSIGHTS", title: "你寫下的軌跡" },
};

export default function App() {
  const [activeView, setActiveView] = useState<AppView>("overview");
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<EntryDetail | null>(null);
  const [entryLoading, setEntryLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [authNotice, setAuthNotice] = useState(readAuthErrorNotice);

  useEffect(() => {
    if (authNotice) {
      clearAuthErrorParams();
    }
  }, [authNotice]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      setData(await fetchAppData());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "暫時無法讀取日記。" );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([getSession(), fetchAppData()]).then(
      ([sessionResult, dataResult]) => {
        if (cancelled) return;

        if (sessionResult.status === "rejected") {
          const reason: unknown = sessionResult.reason;
          setLoadError(reason instanceof Error ? reason.message : "暫時無法讀取日記。" );
          setLoading(false);
          return;
        }

        setSession(sessionResult.value);

        if (dataResult.status === "fulfilled") {
          setData(dataResult.value);
        } else {
          const reason: unknown = dataResult.reason;
          setLoadError(reason instanceof Error ? reason.message : "暫時無法讀取日記。" );
        }

        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase("zh-TW");
    if (!query || !data) return data?.entries ?? [];

    return data.entries.filter((entry) =>
      [entry.title, entry.excerpt, entry.location ?? "", ...entry.tags]
        .join(" ")
        .toLocaleLowerCase("zh-TW")
        .includes(query),
    );
  }, [data, searchQuery]);

  async function openEntry(entryId: string) {
    setSelectedEntry(null);
    setEntryLoading(true);

    try {
      setSelectedEntry(await getEntry(entryId));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "暫時無法讀取這篇日記。" );
      setEntryLoading(false);
      return;
    }

    setEntryLoading(false);
  }

  async function saveEntry(input: Parameters<typeof createEntry>[0]) {
    setSaving(true);
    setSaveError(null);

    try {
      await createEntry(input);
      setShowComposer(false);
      await loadData();
    } catch (error) {
      if (isUnauthorized(error)) {
        // Session expired mid-edit: writing needs a fresh login.
        setSaveError("登入已過期，請重新登入後再儲存。");
        setSession((current) => (current ? { ...current, authenticated: false, canWrite: current.localBypass } : current));
      } else {
        setSaveError(error instanceof Error ? error.message : "暫時無法儲存這篇日記。" );
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);

    try {
      await logout();
      window.location.assign("/");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "暫時無法登出。" );
      setLoggingOut(false);
    }
  }

  const header = viewTitles[activeView];

  return (
    <AppShell activeView={activeView} onChangeView={setActiveView}>
      <PageHeader
        eyebrow={header.eyebrow}
        title={header.title}
        searchQuery={searchQuery}
        canWrite={session ? session.canWrite : true}
        showLogin={session ? !session.authenticated && !session.localBypass : false}
        showLogout={session ? session.authenticated && !session.localBypass : false}
        loggingOut={loggingOut}
        onChangeSearch={setSearchQuery}
        onImport={() => setShowImport(true)}
        onNewEntry={() => {
          setSaveError(null);
          setShowComposer(true);
        }}
        onLogin={() => window.location.assign("/api/auth/login")}
        onLogout={() => void handleLogout()}
      />

      <main className="page-main">
        {authNotice ? (
          <div className="load-error" role="alert">
            <AlertCircle aria-hidden="true" size={24} />
            {authNotice.code === "SUBJECT_NOT_ALLOWED" ? (
              <strong>
                此帳號尚未獲授權。你的帳號識別碼（sub）：<code>{authNotice.sub}</code>
              </strong>
            ) : (
              <strong>登入沒有完成，請再試一次。</strong>
            )}
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setAuthNotice(null)}
            >
              知道了
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="app-loading">
            <LoaderCircle aria-hidden="true" className="spin" size={28} />
            <span>讀取日記</span>
          </div>
        ) : null}

        {!loading && loadError ? (
          <div className="load-error" role="alert">
            <AlertCircle aria-hidden="true" size={24} />
            <strong>{loadError}</strong>
            <button className="button button--secondary" type="button" onClick={() => void loadData()}>
              再試一次
            </button>
          </div>
        ) : null}

        {!loading && data ? (
          <>
            {activeView === "overview" ? (
              <OverviewView
                entries={filteredEntries}
                activity={data.overview.activity}
                monthly={data.overview.monthly}
                stats={data.overview.stats}
                onOpenEntry={(entryId) => void openEntry(entryId)}
                onShowTimeline={() => setActiveView("timeline")}
              />
            ) : null}
            {activeView === "timeline" ? (
              <TimelineView entries={filteredEntries} onOpenEntry={(entryId) => void openEntry(entryId)} />
            ) : null}
            {activeView === "calendar" ? <CalendarView activity={data.overview.activity} /> : null}
            {activeView === "places" ? <PlacesView entries={filteredEntries} /> : null}
            {activeView === "insights" ? (
              <InsightsView monthly={data.overview.monthly} activity={data.overview.activity} />
            ) : null}
          </>
        ) : null}
      </main>

      {entryLoading || selectedEntry ? (
        <Suspense
          fallback={(
            <div className="dialog-backdrop" role="status">
              <div className="dialog-loading import-loading">
                <LoaderCircle aria-hidden="true" className="spin" size={28} />
                <span>讀取日記</span>
              </div>
            </div>
          )}
        >
          <EntryDetailDialog
            entry={selectedEntry}
            loading={entryLoading}
            onClose={() => {
              setSelectedEntry(null);
              setEntryLoading(false);
            }}
          />
        </Suspense>
      ) : null}

      {showComposer ? (
        <NewEntryDialog
          saving={saving}
          error={saveError}
          onClose={() => setShowComposer(false)}
          onSave={saveEntry}
        />
      ) : null}

      {showImport ? (
        <Suspense
          fallback={(
            <div className="dialog-backdrop" role="status">
              <div className="dialog-loading import-loading">
                <LoaderCircle aria-hidden="true" className="spin" size={28} />
                <span>準備匯入工具</span>
              </div>
            </div>
          )}
        >
          <ImportDialog
            onClose={() => setShowImport(false)}
            onImported={loadData}
          />
        </Suspense>
      ) : null}
    </AppShell>
  );
}
