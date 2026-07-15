import {
  BarChart3,
  BookOpenText,
  CalendarDays,
  LayoutDashboard,
  MapPinned,
  NotebookTabs,
} from "lucide-react";
import type { ReactNode } from "react";

export type AppView = "overview" | "timeline" | "calendar" | "places" | "insights";

interface NavigationItem {
  id: AppView;
  label: string;
  icon: typeof LayoutDashboard;
}

const navigation: NavigationItem[] = [
  { id: "overview", label: "總覽", icon: LayoutDashboard },
  { id: "timeline", label: "時間軸", icon: BookOpenText },
  { id: "calendar", label: "日曆", icon: CalendarDays },
  { id: "places", label: "地點", icon: MapPinned },
  { id: "insights", label: "Insights", icon: BarChart3 },
];

interface AppShellProps {
  activeView: AppView;
  children: ReactNode;
  onChangeView: (view: AppView) => void;
}

export function AppShell({ activeView, children, onChangeView }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          type="button"
          onClick={() => onChangeView("overview")}
          aria-label="回到總覽"
        >
          <span className="brand__mark" aria-hidden="true">
            P
          </span>
          <span>
            <strong>PG72 Diary</strong>
            <small>PRIVATE JOURNAL</small>
          </span>
        </button>

        <nav className="sidebar__nav" aria-label="主要導覽">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className="nav-item"
                data-active={activeView === item.id}
                key={item.id}
                type="button"
                onClick={() => onChangeView(item.id)}
              >
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <NotebookTabs aria-hidden="true" size={17} />
          <span>
            <strong>日常</strong>
            <small>7 篇示範日記</small>
          </span>
        </div>
      </aside>

      <div className="app-content">{children}</div>

      <nav className="mobile-nav" aria-label="行動版導覽">
        {navigation.slice(0, 4).map((item) => {
          const Icon = item.icon;
          return (
            <button
              data-active={activeView === item.id}
              key={item.id}
              type="button"
              onClick={() => onChangeView(item.id)}
            >
              <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
