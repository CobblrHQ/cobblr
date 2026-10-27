import { request } from "./client";

export interface SearchHit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  detailUrl?: string;
  /** Archived / out of use. Search still finds these, after the live ones. */
  retired?: boolean;
  /** Found inside the record's words (a pattern's PDF, its notes) rather
   *  than its name: the line the searched word is on. */
  snippet?: string;
  /** Where it is, every step up: "Backpack, in Desk drawer". */
  where?: string;
  fields: Record<string, unknown>;
}

export const searchApi = {

  // ─── core-search ──────────────────────────────────────────────────
  // Either `q` (free-text) or `tag` (D7 tag-filter) is required; both
  // can be combined to narrow tagged entities by name as well.
  search: (
    slug: string,
    args: { q?: string; kinds?: string; tag?: string; per_kind?: number; offset?: number } | string,
  ) => {
    const a = typeof args === "string" ? { q: args } : args;
    const qs = new URLSearchParams();
    if (a.q) qs.set("q", a.q);
    if (a.kinds) qs.set("kinds", a.kinds);
    if (a.tag) qs.set("tag", a.tag);
    if (a.per_kind) qs.set("per_kind", String(a.per_kind));
    if (a.offset) qs.set("offset", String(a.offset));
    return request<{
      items: SearchHit[];
      kinds_searched: string[];
      /** Kinds whose search FAILED (not "no matches"). */
      kinds_failed?: string[];
      /** Kinds that filled their share, so may have more past `offset + per_kind`. */
      more_kinds?: string[];
      /** How many each kind holds in all, for the kinds whose list can count. */
      totals?: Record<string, number>;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-search/search?${qs.toString()}`,
    );
  },

  /** The kinds a search can reach in this workspace (a list resolver, its
   *  module on), for the search page's kind picker. */
  searchKinds: (slug: string) =>
    request<{ items: Array<{ id: string; display_name: string; display_name_plural: string | null }> }>(
      "GET",
      `/orgs/${slug}/modules/core-search/search/kinds`,
    ),
};
