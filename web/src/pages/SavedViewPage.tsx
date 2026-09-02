// /views/:viewId — a saved view as a REAL page. The dashboard's pinned-view
// cards land here, so opening "Printer fleet by state" gives the view the
// whole screen instead of a preview modal floating over the /views config
// list (reported: the modal-on-config-page read as broken). The config page
// keeps its modal for in-place previewing.

import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { SavedViewBody } from "./ViewsPage";

/** A saved view as a page. Also hosted WHOLE by the instance page as a tab
 *  (`viewId` + `embedded`): the instance owns the heading then, and this
 *  renders only the view. */
export function SavedViewPage({ viewId: viewIdProp, embedded = false }: { viewId?: string; embedded?: boolean } = {}) {
  const params = useParams<{ viewId: string }>();
  const viewId = viewIdProp ?? params.viewId;
  const { activeSlug } = useActiveOrg();
  const views = useQuery({
    queryKey: ["saved-views", activeSlug],
    queryFn: () => api.listSavedViews(activeSlug),
    enabled: !!activeSlug,
  });
  const view = (views.data?.items ?? []).find((v) => v.id === viewId) ?? null;
  const data = useQuery({
    queryKey: ["view-data", activeSlug, viewId],
    queryFn: () => api.viewData(activeSlug, viewId!),
    enabled: !!activeSlug && !!view,
  });
  usePageTitle(view?.name ?? "View");

  if (views.isLoading) {
    return <div className="text-sm text-muted">Loading…</div>;
  }
  if (!view) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">This view doesn't exist (it may have been deleted).</p>
        <Link to="/views" className="text-sm text-accent hover:underline">
          All views
        </Link>
      </div>
    );
  }
  if (embedded) {
    return <SavedViewBody view={view} items={data.data?.items ?? []} isLoading={data.isLoading} />;
  }
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <Link
          to="/views"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-accent shrink-0"
        >
          <ChevronLeft size={15} /> Views
        </Link>
        <h1 className="text-2xl font-semibold text-content dark:text-mortar-100 truncate">
          {view.name}
        </h1>
      </div>
      <SavedViewBody view={view} items={data.data?.items ?? []} isLoading={data.isLoading} />
    </div>
  );
}
