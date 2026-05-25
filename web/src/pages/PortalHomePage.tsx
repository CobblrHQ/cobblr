// Root of the member portal — welcome markdown + a tile list of the
// admin-pinned views. Each tile links to /portal/:slug/views/:viewId
// where PortalViewPage renders that view in read-only mode.
//
// Empty state (no pinned views): show a friendly note. Admins see
// "configure portal" CTA; non-admins see "ask an admin to pin views."

import { Link, useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, LayoutGrid, Settings } from "lucide-react";
import { api, type PortalConfig } from "../lib/api";
import { usePageTitle } from "@cobblr/platform-web";

interface PortalCtx {
  portalConfig: PortalConfig;
  activeSlug: string | null;
}

export function PortalHomePage() {
  const { portalConfig, activeSlug } = useOutletContext<PortalCtx>();
  usePageTitle(portalConfig.display_name ?? "Portal");

  // We need view names; fetch all saved views and filter to the
  // pinned ids. Cheap — saved views are workspace-scoped and small.
  const allViews = useQuery({
    queryKey: ["portal-views", activeSlug],
    queryFn: () => api.listSavedViews(activeSlug!),
    enabled: !!activeSlug && portalConfig.pinned_views.length > 0,
  });
  const caps = useQuery({
    queryKey: ["my-capabilities", activeSlug],
    queryFn: () => api.getMyCapabilities(activeSlug!),
    enabled: !!activeSlug,
  });
  const isAdmin = caps.data?.role === "owner" || caps.data?.role === "admin";

  const pinnedViews = (allViews.data?.items ?? []).filter((v) =>
    portalConfig.pinned_views.includes(v.id),
  );
  // Preserve admin's ordering — pinned_views is an ordered list.
  pinnedViews.sort(
    (a, b) =>
      portalConfig.pinned_views.indexOf(a.id) -
      portalConfig.pinned_views.indexOf(b.id),
  );

  return (
    <div className="space-y-6">
      {portalConfig.welcome_markdown && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 text-slate-700 dark:text-mortar-100 text-sm whitespace-pre-wrap">
          {portalConfig.welcome_markdown}
        </div>
      )}

      {pinnedViews.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 bg-mortar-50/30 dark:bg-slate-800/30 p-8 text-center">
          <LayoutGrid size={24} className="mx-auto text-slate-300 dark:text-slate-600 mb-2" />
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No pinned views yet.
          </p>
          {isAdmin ? (
            <Link
              to="/configuration/portal"
              className="text-xs text-cobble-600 hover:text-cobble-700 mt-2 inline-flex items-center gap-1"
            >
              <Settings size={11} /> configure portal
            </Link>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
              Ask an admin to pin some views here.
            </p>
          )}
        </div>
      )}

      {pinnedViews.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {pinnedViews.map((v) => (
            <Link
              key={v.id}
              to={`/portal/${activeSlug}/views/${v.id}`}
              className="group rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 hover:border-cobble-400 dark:hover:border-cobble-600 transition flex items-center gap-3"
            >
              <LayoutGrid
                size={18}
                className="text-cobble-500 dark:text-cobble-400 shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-700 dark:text-mortar-100 truncate">
                  {v.name}
                </div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 truncate">
                  {v.entity_kind} · {v.view_type}
                </div>
              </div>
              <ChevronRight
                size={14}
                className="text-slate-300 dark:text-slate-600 group-hover:text-cobble-500 transition shrink-0"
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
