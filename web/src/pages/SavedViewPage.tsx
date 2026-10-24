// /views/:viewId — a saved view as a REAL page. The dashboard's pinned-view
// cards land here, so opening "Printer fleet by state" gives the view the
// whole screen instead of a preview modal floating over the /views config
// list (reported: the modal-on-config-page read as broken). The config page
// keeps its modal for in-place previewing.

import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { usePageTitle } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { SavedViewBody } from "./ViewsPage";
import { useViewData } from "../lib/useViewData";
import { viewInputsFromSearch } from "@cobblr/platform-contract/view-inputs";
import { ViewInputsBar } from "../components/ViewInputsBar";

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
  // The view's kind rides in the key, so an action on one of its records
  // refreshes this page wherever it is embedded (platform-web run-action):
  // Groceries → What's on hand kept ×1 after Use until a reload (#2969).
  // The view's inputs ride in the URL (`?in.scale=2`), so a scaled view is a
  // link that reopens scaled (#6897).
  const [search] = useSearchParams();
  const inputs = viewInputsFromSearch(search);
  const data = useViewData(activeSlug, viewId, view?.entity_kind ?? "", { enabled: !!view, inputs, view: view ?? undefined });
  const bar = data.inputs ? <ViewInputsBar declared={data.inputs.declared} values={data.inputs.values} notes={data.inputs.notes} /> : null;
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
    return (
      <div className="space-y-3">
        {bar}
        <SavedViewBody view={view} data={data} />
      </div>
    );
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
      {bar}
      <SavedViewBody view={view} data={data} />
    </div>
  );
}
