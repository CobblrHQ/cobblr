// The way to every app that is not in the sidebar, at the end of the
// collections: ⊞ More apps · N, N being the ones off in the workspace plus the
// ones hidden from this sidebar. A distinct control, not another row: the
// owner had to be told "All apps" existed (#3883). Every nav (the sidebar,
// the top bar's menu, the phone's menu) draws this one, so none of them can
// lose the way out.
import { NavLink } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import { useAppCatalog } from "../lib/appCatalog";

/** How many apps are not in the sidebar: off, or hidden from it here. */
export function useAppsNotInSidebar(): number {
  const { apps } = useAppCatalog();
  return apps.filter((a) => a.state !== "on").length;
}

export function MoreAppsDoor({ onNavigate, className = "" }: { onNavigate?: () => void; className?: string }) {
  const n = useAppsNotInSidebar();
  return (
    <NavLink
      to="/apps"
      data-testid="nav-all-apps"
      data-count={n}
      onClick={onNavigate}
      aria-label={n > 0 ? `More apps, ${n} not in your sidebar` : "More apps"}
      title="Every app this workspace can do, including the ones not in your sidebar"
      className={`inline-flex w-full items-center gap-2 rounded-md border border-dashed border-line dark:border-slate-600 px-3 py-1.5 text-[13px] font-medium text-muted dark:text-slate-400 hover:border-accent hover:text-accent transition ${className}`}
    >
      <LayoutGrid size={14} className="shrink-0" />
      <span className="truncate">More apps</span>
      {n > 0 && <span className="shrink-0 tabular-nums">· {n}</span>}
    </NavLink>
  );
}
