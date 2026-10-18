import { fetchCsv, request } from "./client";
import { dayHere } from "@cobblr/platform-contract/day";
import type { DashboardSnapshot } from "@cobblr/platform-contract/dashboard-reads";

/** Admin dashboard arrangement. `widgets` orders the "at a glance" tiles (ids
 *  owned by the platform-web registry) with a hidden flag and an optional
 *  column-span (tile width). `sections` orders the whole dashboard sections
 *  (at_a_glance / pinned_views / recent_activity) with a hidden flag. The
 *  server persists order + visibility only. */
export interface DashboardLayout {
  widgets: { id: string; hidden: boolean; span?: number }[];
  sections?: { id: string; hidden: boolean }[];
}

export interface SavedView {
  id: string;
  entity_kind: string;
  name: string;
  view_type: string;
  config: Record<string, unknown>;
  is_default: boolean;
  /** v0.3: when true the dashboard renders this view's data inline. */
  pinned: boolean;
  owner_user_id: string | null;
  /** Set when a bundle shipped this view; `bundle_base` is the view as the
   *  bundle made it, so a person's changes are the difference. */
  bundle_id?: string | null;
  bundle_base?: { name: string; view_type: string; config: Record<string, unknown>; is_default: boolean; pinned: boolean } | null;
  created_at: string;
  updated_at: string;
}

export interface ViewDataResponse {
  groups?: import("@cobblr/platform-contract").EntityGroup[];
  totals?: import("@cobblr/platform-contract").GroupedResult["totals"];
  weighted_by?: import("@cobblr/platform-contract").GroupedResult["weighted_by"];
  group_total?: number;
  view: { id: string; name: string; entity_kind: string; view_type: string };
  items: Array<{
    kind: string;
    id: string;
    title: string;
    subtitle?: string;
    image_path?: string;
    detailUrl?: string;
    fields: Record<string, unknown>;
  }>;
  /** How many records the view holds: the collection's own count, never the
   *  length of `items`. Null when the collection could not say (a very large
   *  one that does not count, past the walk's cap). */
  total: number | null;
  /** False when `items` is not every record (past the cap, or a page asked
   *  for with a limit): the surface says so and offers the rest. */
  complete: boolean;
  /** With no rows: true when the collection itself has nothing (a first-item
   *  door belongs here), false when the view's filter excluded everything. */
  collection_empty?: boolean;
  /** The view's own filters the collection could not run. Shown, so an
   *  unfiltered list never passes for the filtered one. */
  unapplied?: Array<{ col: string; op: string; value?: unknown; ref_col?: string }>;
  /** The view's inputs (#6897): what it declares, the values its computed
   *  fields were read with, and a note for each value the server had to bound. */
  inputs?: { declared: import("@cobblr/platform-contract/view-inputs").ViewInput[]; values: Record<string, string | number>; notes: import("@cobblr/platform-contract/view-inputs").ViewInputNote[] };
  /** The view's own grouping the collection cannot read (an older bundle's
   *  view naming a field its records lack): the rows come back ungrouped,
   *  and the surface says so instead of opening onto an error. */
  ungrouped?: { group_by: unknown; reason: string };
}

export const viewsApi = {
  /** A saved view as a spreadsheet: its filter, sort and columns. */
  exportViewCsv: (slug: string, viewId: string, subtotals = false) =>
    fetchCsv(`/orgs/${slug}/modules/core-views/views/${encodeURIComponent(viewId)}/export.csv${subtotals ? "?subtotals=true" : ""}`),

  // ─── core-views ───────────────────────────────────────────────────
  listSavedViews: (slug: string, kind?: string) =>
    request<{ items: SavedView[] }>(
      "GET",
      `/orgs/${slug}/modules/core-views/views${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  createSavedView: (slug: string, body: Partial<SavedView> & { shared?: boolean }) =>
    request<SavedView>("POST", `/orgs/${slug}/modules/core-views/views`, body),
  updateSavedView: (
    slug: string,
    id: string,
    body: Partial<SavedView> & { shared?: boolean },
  ) =>
    request<SavedView>(
      "PATCH",
      `/orgs/${slug}/modules/core-views/views/${id}`,
      body,
    ),
  /** Put a bundle's view back as the bundle made it. */
  resetSavedView: (slug: string, id: string) =>
    request<SavedView>("POST", `/orgs/${slug}/modules/core-views/views/${id}/reset`, {}),
  deleteSavedView: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-views/views/${id}`),
  viewData: (slug: string, id: string, params?: { q?: string; limit?: number; offset?: number; group_offset?: number; group_keys?: Array<string | null>; inputs?: Record<string, string> }) => {
    const qs = new URLSearchParams();
    // This browser's day: a view's "today" (a "Ready to drink" window) is the
    // reader's, and the server cannot tell it from a UTC clock.
    qs.set("today", dayHere());
    if (params?.q) qs.set("q", params.q);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    if (params?.group_offset !== undefined) qs.set("group_offset", String(params.group_offset));
    if (params?.group_keys) qs.set("group_keys", JSON.stringify(params.group_keys));
    // What the viewer set the view's inputs to (#6897); the server bounds them.
    if (params?.inputs && Object.keys(params.inputs).length) qs.set("inputs", JSON.stringify(params.inputs));
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return request<ViewDataResponse>(
      "GET",
      `/orgs/${slug}/modules/core-views/views/${id}/data${tail}`,
    );
  },
  /** Every dashboard section's reads in one answer (#6563). `today` and the
   *  Up next window are the reader's; the server cannot tell them. */
  getDashboardSnapshot: (slug: string, at: { today: string; from: string; to: string }) =>
    request<DashboardSnapshot>("GET", `/orgs/${slug}/dashboard?${new URLSearchParams(at).toString()}`),
  getDashboardLayout: (slug: string) =>
    request<{ layout: DashboardLayout }>(
      "GET",
      `/orgs/${slug}/dashboard-layout`,
    ),
  setDashboardLayout: (slug: string, body: DashboardLayout) =>
    request<{ layout: DashboardLayout }>(
      "PUT",
      `/orgs/${slug}/dashboard-layout`,
      body,
    ),
};
