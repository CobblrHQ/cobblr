import { type Edit } from "@cobblr/platform-web";
import { request } from "./client";

/** Built-in renderers Cobblr's web UI knows how to draw against a
 *  catalog entry's `payload[fieldName]`. Catalogs (and later: entity
 *  kinds + bundle presentation overrides) declare which renderer to
 *  use per field via CatalogSchema.field_renderers. */
export type CatalogFieldRenderer =
  | "text"        // default — String(value)
  | "color-hex"   // "0033B2" → swatch + uppercase hex
  | "image-url"   // URL → thumbnail
  | "url-link"    // URL → clickable link
  | "year"        // 1965 → "1965"
  | "boolean"     // "True"/"true"/1/0 → ✓ / ✕
  | "code"        // monospace + bg, for SKUs / model numbers
  | "markdown"    // rich text — rendered Markdown (block) / stripped (inline)
  | "qr";         // a scannable QR of the value (owned codes: UPC, tag, URL)

export interface CatalogSchema {
  id_column?: string;
  title_column?: string;
  image_column?: string;
  subtitle_column?: string;
  description_column?: string;
  field_renderers?: Record<string, CatalogFieldRenderer>;
  /** Pretty labels for payload keys — `{ is_trans: "Transparent" }`.
   *  Falls back to the raw key when not set. */
  field_labels?: Record<string, string>;
  /** Catalog-match prefill: `{ catalogPayloadKey: instanceFieldName }` — picking
   *  an entry fills those instance fields from its payload. */
  field_map?: Record<string, string>;
  /** Which entity kinds this catalog is meaningful to match against.
   *  Omitted ⇒ catalog appears in the picker for every source kind
   *  the action applies to. */
  bindable_to_kinds?: string[];
  /** Stable semantic identifier — e.g. "lego.set", "mcmaster.part".
   *  Lets other modules look up "the canonical sets catalog" without
   *  hardcoding a bundle id. See 2026-05-25-audit.md S5. */
  semantic_type?: string;
  /** Replaces the card's image slot with a renderer drawing
   *  `payload[hero_field]`. E.g. Rebrickable colors set
   *  hero_field=rgb + hero_renderer=color-hex → cards show big
   *  color swatches where the photo would be. */
  hero_field?: string;
  hero_renderer?: CatalogFieldRenderer;
}

export interface Catalog {
  id: string;
  /** Custom fields a bundle or a person defines for catalogs. */
  metadata?: Record<string, unknown>;
  name: string;
  description: string | null;
  source_url: string | null;
  puller_id: string | null;
  schema: CatalogSchema;
  last_sync_at: string | null;
  entry_count: number;
  /** `hosted` — rows live in Cobblr's shared reference-catalog service, not
   *  this workspace's DB, so `entry_count` is 0 by design; the catalog is
   *  still fully usable (matches resolve against the service). `local` — rows
   *  imported into this workspace. Absent on older installs → treat as local. */
  source?: "local" | "hosted";
  created_at: string;
  updated_at: string;
}

export interface CatalogEntry {
  id: string;
  catalog_id: string;
  external_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Result row from /catalogs/search — denormalised so the typeahead
 *  can render `<title> · <catalog_name>` without a second lookup. */
export interface CatalogSearchHit {
  id: string;
  catalog_id: string;
  catalog_name: string;
  external_id: string;
  payload: Record<string, unknown>;
  title: string;
  title_column: string;
  /** `{ catalogPayloadKey: instanceFieldName }` from the catalog's schema —
   *  picking a hit prefills those instance fields from the payload. */
  field_map?: Record<string, string>;
}

export const catalogsApi = {

  // core-catalogs — imported reference datasets (Rebrickable parts,
  // Open Library books, Open Food Facts groceries, etc.). User entities
  // point at rows here via `entity_pairings` with `relationship_kind: "matches"`.
  listCatalogs: (slug: string) =>
    request<{ items: Catalog[] }>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs`,
    ),
  getCatalog: (slug: string, id: string) =>
    request<Catalog>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}`,
    ),
  createCatalog: (slug: string, body: Partial<Catalog>) =>
    request<Catalog>(
      "POST",
      `/orgs/${slug}/modules/core-catalogs/catalogs`,
      body,
    ),
  /** `edit` from editOf: only what changed, and what it was when the form opened (#7925). */
  updateCatalog: (slug: string, id: string, edit: Edit<Catalog>) =>
    request<Catalog>(
      "PATCH",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}`,
      edit.body,
      edit.headers,
    ),
  deleteCatalog: (slug: string, id: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}`,
    ),
  importCatalogCsv: (
    slug: string,
    id: string,
    body: { csv: string; schema?: CatalogSchema },
  ) =>
    request<{ imported: number; total: number; schema_used: CatalogSchema }>(
      "POST",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}/import-csv`,
      body,
    ),
  /** Pull a catalog's rows from its source_url (the built-in puller — fetches +
   *  gunzips the CSV). One-tap import for a bundle-shipped catalog shell (e.g.
   *  Rebrickable), replacing the hand-run seeder. */
  pullCatalog: (slug: string, id: string) =>
    request<{ imported: number; total: number; source_url: string }>(
      "POST",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${id}/pull`,
      {},
    ),
  listCatalogEntries: (
    slug: string,
    catalogId: string,
    params: { q?: string; limit?: number; offset?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    const trailing = qs.toString() ? `?${qs}` : "";
    return request<{
      items: CatalogEntry[];
      title_column: string;
      /** Present for hosted catalogs: whether this catalog's rows can be
       *  browsed/searched via the shared service (false for the BOM). */
      hosted?: boolean;
      browsable?: boolean;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs/${catalogId}/entries${trailing}`,
    );
  },
  /** Cross-catalog search — single call, results from every installed
   *  catalog in the workspace (except those with
   *  `schema.exclude_from_global_search: true`). Used by the catalog-
   *  aware quick-add typeahead on entity create forms. */
  searchCatalogs: (
    slug: string,
    params: { q: string; limit?: number; catalog_ids?: string[] },
  ) => {
    const qs = new URLSearchParams({ q: params.q });
    if (params.limit) qs.set("limit", String(params.limit));
    // id-list-in-url: the workspace's installed catalogs, a handful at most, never its records.
    if (params.catalog_ids?.length) qs.set("catalog_ids", params.catalog_ids.join(","));
    return request<{ items: CatalogSearchHit[] }>(
      "GET",
      `/orgs/${slug}/modules/core-catalogs/catalogs/search?${qs}`,
    );
  },
};
