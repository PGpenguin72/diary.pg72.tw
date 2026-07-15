import { AlertCircle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EntryDetail, OverviewResponse, TimelineEntry } from "../shared/api";
import { AppShell, type AppView } from "./components/AppShell";
import { EntryDetailDialog } from "./components/EntryDetailDialog";
import { ImportDialog } from "./components/ImportDialog";
import { NewEntryDialog } from "./components/NewEntryDialog";
import { PageHeader } from "./components/PageHeader";
import {
  CalendarView,
  InsightsView,
  OverviewView,
  PlacesView,
  TimelineView,
} from "./components/Views";
import { createEntry, getEntry, getOverview, getTimeline } from "./lib/api";

interface AppData {
  overview: OverviewResponse;
  entries: TimelineEntry[];
}

async function fetchAppData(): Promise<AppData> {
  const [overview, timeline] = await Promise.all([getOverview(), getTimeline()]);
  return { overview, entries: timeline.entries };
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

    void fetchAppData()
      .then((nextData) => {
        if (!cancelled) setData(nextData);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "暫時無法讀取日記。" );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

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
      setSaveError(error instanceof Error ? error.message : "暫時無法儲存這篇日記。" );
    } finally {
      setSaving(false);
    }
  }

  const header = viewTitles[activeView];

  return (
    <AppShell activeView={activeView} onChangeView={setActiveView}>
      <PageHeader
        eyebrow={header.eyebrow}
        title={header.title}
        searchQuery={searchQuery}
        onChangeSearch={setSearchQuery}
        onImport={() => setShowImport(true)}
        onNewEntry={() => {
          setSaveError(null);
          setShowComposer(true);
        }}
      />

      <main className="page-main">
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
        <EntryDetailDialog
          entry={selectedEntry}
          loading={entryLoading}
          onClose={() => {
            setSelectedEntry(null);
            setEntryLoading(false);
          }}
        />
      ) : null}

      {showComposer ? (
        <NewEntryDialog
          saving={saving}
          error={saveError}
          onClose={() => setShowComposer(false)}
          onSave={saveEntry}
        />
      ) : null}

      {showImport ? <ImportDialog onClose={() => setShowImport(false)} /> : null}
    </AppShell>
  );
}
