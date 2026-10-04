// The way to every app that is not in the sidebar, at the end of the
// collections: ⊞ More apps · N, N being the ones off in the workspace plus the
// ones hidden from this sidebar. A distinct control, not another row: the
// owner had to be told "All apps" existed (#3883). Every nav (the sidebar,
// the top bar, the phone's menu) draws one, so none of them can lose the way
// out. The top bar's is a chip on the row itself, not a row inside "more ▾":
// that menu only exists when the row overflows, so a workspace with four
// apps had no door at all (#4143).
import { NavLink } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import { useAppCatalog } from "../lib/appCatalog";

/** How many apps are not in the sidebar: off, or hidden from it here. */
export function useAppsNotInSidebar(): number {
  const { apps } = useAppCatalog();
  return apps.filter((a) => a.state !== "on").length;
}

export function MoreAppsDoor({ onNavigate, className = "", plain = false }: { onNavigate?: () => void; className?: string; plain?: boolean }) {
  const n = useAppsNotInSidebar();
  return (
    <NavLink
      to="/apps"
      data-testid="nav-all-apps"
      data-count={n}
      onClick={onNavigate}
      aria-label={n > 0 ? `More apps, ${n} not in your sidebar` : "More apps"}
      title="Every app this workspace can do, including the ones not in your sidebar"
      className={`${plain ? "flex w-full items-center gap-2 text-sm text-muted dark:text-slate-400 hover:text-accent transition" : "inline-flex w-full items-center gap-2 rounded-md border border-dashed border-line dark:border-slate-600 px-3 py-1.5 text-[13px] font-medium text-muted dark:text-slate-400 hover:border-accent hover:text-accent transition"} ${className}`}
    >
      <LayoutGrid size={14} className="shrink-0" />
      <span className="truncate">More apps</span>
      {n > 0 && <span className="shrink-0 tabular-nums">· {n}</span>}
    </NavLink>
  );
}

/** The top bar's door: a fixed chip at the end of the row, beside Home's
 *  weight, never folded away. */
export function AppsDoorChip() {
  const n = useAppsNotInSidebar();
  return (
    <NavLink
      to="/apps"
      data-testid="nav-all-apps"
      data-count={n}
      data-navfixed
      aria-label={n > 0 ? `All apps, ${n} not in the top bar` : "All apps"}
      title="All apps: every app this workspace can do, including the ones not in your sidebar"
      className={({ isActive }) =>
        "inline-flex shrink-0 items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-xs font-medium tabular-nums transition " +
        (isActive
          ? "border-accent text-accent"
          : "border-line dark:border-slate-600 text-muted dark:text-slate-400 hover:border-accent hover:text-accent")
      }
    >
      <LayoutGrid size={13} className="shrink-0" />
      {n > 0 && <span>{n}</span>}
    </NavLink>
  );
}
