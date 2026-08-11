// Thin fetch wrapper scoped to the inventory module's REST surface.
// The host app provides the auth token via getToken(); we just build
// URLs and parse responses.
//
// Each method takes the org slug because the module's routes are
// mounted at /api/v1/orgs/:slug/modules/inventory/... — the platform
// pre-applies auth + tenant resolution on every request.

import type { FieldRendererId, FieldType } from "@cobblr/platform-web";

export type AllocationStatus = "reserved" | "consumed" | "released";

/** Subset of a platform field-def the parts table needs to render custom
 *  columns (label + value renderer). A structural subset of @cobblr/platform-web's
 *  PlatformFieldDef, and `type`/`renderer` borrow ITS unions rather than
 *  restating them as `string`: the shared field components switch exhaustively
 *  over those unions (see fieldControl), so a def typed loosely here could carry
 *  a type they don't handle and throw at render. Narrow types make that a
 *  compile error instead. */
export interface InvFieldDef {
  id: string;
  name: string;
  display_label: string;
  type: FieldType;
  position: number;
  choices?: string[] | null;
  renderer?: FieldRendererId | null;
  /** Plain-language one-line hint shown under the input. */
  help?: string | null;
  /** Declared unit for type='number' values ("mm", "g") — rendered as a
   *  quantity suffix; resolved against the units vocabulary. */
  unit?: string | null;
  /** Server-managed: value stamped server-side; never render an input. */
  server_managed?: boolean | null;
  /** type='relation' only: the referenced entity-kind id. */
  ref_kind?: string | null;
  /** type='computed' only: the {{ }} template rendered read-only server-side.
   *  Per-unit consumption reads this to detect a DERIVED capacity + its source
   *  field for the provenance chip. */
  template?: string | null;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  parent_id: string | null;
  created_at: string;
}

export interface Location {
  id: string;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  depth: number;
  kind: "container" | "area";
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Fields the part record carries past the workshop-BOM basics —
 *  HomeBox parity. Same shape on both list and detail. */
export interface HomeBoxFields {
  asset_id: number | null;
  serial_number: string | null;
  model_number: string | null;
  /** The individual's holder — "Janet", "IT Dept", "Loaned to Bob". A generic
   *  relabelable field (a library calls it "Borrower"); see per-unit-assignment.md. */
  assigned_to: string | null;
  warranty_expires: string | null;
  lifetime_warranty: boolean;
  warranty_details: string | null;
  insured: boolean;
  archived: boolean;
}

export interface PartListItem extends HomeBoxFields {
  id: string;
  name: string;
  description: string | null;
  qty: number;
  unit: string;
  cost: number | null;
  min_qty: number | null;
  manufacturer: string | null;
  supplier_url: string | null;
  image_path: string | null;
  notes: string | null;
  /** An ESTIMATE, not a count. Its presence marks this record as an
   *  assortment ("roughly 50 adapters, jumbled together") and is what earns it
   *  the photo-led card instead of a stock row. */
  approximate_qty: number | null;
  estimated_at: string | null;
  state: "active" | "draft" | "needs_review";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  category_id: string | null;
  category_name: string | null;
  location_id: string | null;
  location_name: string | null;
  assigned_qty: number;
  available_qty: number;
  low_stock: boolean;
  /** How many UNITS (serials) this model has on file. Derived server-side, and
   *  batched for the whole page. Absent on an older response; 0 means the model
   *  isn't serialized. The list uses it only for the passive "not yet scanned"
   *  chip — the reconciliation QUESTION lives on the detail, where it can be
   *  answered. See docs/design-decisions/serialized-rollup-and-stock-adjust.md. */
  units_count?: number;
  /** Computed: positive = days until expiry, negative = already
   *  expired, null = no warranty date. */
  warranty_days_until: number | null;
}

export interface Part extends HomeBoxFields {
  id: string;
  name: string;
  description: string | null;
  qty: string;
  unit: string;
  cost: string | null;
  min_qty: string | null;
  manufacturer: string | null;
  supplier_url: string | null;
  image_path: string | null;
  notes: string | null;
  state: "active" | "draft" | "needs_review";
  metadata: Record<string, unknown>;
  category_id: string | null;
  location_id: string | null;
  created_at: string;
  updated_at: string;
  /** An ESTIMATE, not a count. String like its numeric siblings on this type
   *  (pg returns numerics as strings). Its presence marks an assortment. */
  approximate_qty: string | null;
  estimated_at: string | null;
  /** How many UNITS (serials) are on file for this model. DERIVED server-side
   *  from the unit-of pairings, never stored: `qty` stays the count face's
   *  number and this is the individual face's. 0 (or absent, on an older
   *  response) means the model isn't serialized and nothing below applies.
   *  See docs/design-decisions/serialized-rollup-and-stock-adjust.md. */
  units_count?: number;
  /** When the newest unit was paired — the "have the numbers settled?" signal.
   *  Detail only; the list has no use for it. */
  units_latest_at?: string | null;
  /** Present (non-null) only when this model has units AND its two numbers
   *  disagree. Detail only — a question belongs where you can answer it; the
   *  list computes its passive chip from qty + units_count. */
  reconcile?: {
    direction: "under" | "over";
    qty: number;
    units_count: number;
    stable: boolean;
    dismissed: boolean;
  } | null;
}

export interface ConsumptionRow {
  id: string;
  delta: string; // signed: negative = consumed
  reason: string | null;
  source_kind: string | null;
  source_id: string | null;
  at: string;
}

export interface SpoolmanConnection {
  id: string;
  label: string;
  base_url: string;
  last_sync_status: string | null;
}

export interface ImportRow {
  name: string;
  qty: number;
  unit: string | null;
  cost: number | null;
  min_qty: number | null;
  manufacturer: string | null;
  notes: string | null;
  category_name: string | null;
  location_name: string | null;
  row_number: number;
  warnings: string[];
}

export interface ImportResponse {
  rows: ImportRow[];
  errors: { row_number: number; message: string }[];
  detected_headers: Record<string, string | null>;
  committed: number;
  ids?: string[];
}

export interface Allocation {
  id: string;
  part_id: string;
  qty: string;
  status: AllocationStatus;
  target_module: string;
  target_entity_type: string;
  target_entity_id: string;
  reason: string | null;
  reserved_at: string;
  consumed_at: string | null;
  released_at: string | null;
}

export class InventoryApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface InventoryApiOptions {
  /** Returns the current Bearer token. Re-invoked on every call so
   *  the host's logout / refresh flow stays in charge. */
  getToken: () => string | null;
  /** When set, parts CRUD targets
   *  /orgs/:slug/instances/<instance>/items instead of
   *  /modules/inventory/parts — scopes the page to one module
   *  instance. Unset = the default inventory instance (legacy URLs). */
  instance?: string;
}

export class InventoryApi {
  constructor(private readonly slug: string, private readonly opts: InventoryApiOptions) {}

  private base(): string {
    return `/api/v1/orgs/${this.slug}/modules/inventory`;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestAbs<T>(method, `${this.base()}${path}`, body);
  }

  /** Base for the primary-entity (parts) CRUD. Instance-scoped when an
   *  instance is set; the legacy module route otherwise. The platform's
   *  /instances/:name/items dispatches to inventory's parts router, so
   *  the sub-paths ("", "/:id", "/export.csv", "/:id/stock-adjust")
   *  line up identically either way. */
  private partsBase(): string {
    return this.opts.instance
      ? `/api/v1/orgs/${this.slug}/instances/${this.opts.instance}/items`
      : `${this.base()}/parts`;
  }
  private partsRequest<T>(method: string, subpath: string, body?: unknown): Promise<T> {
    return this.requestAbs<T>(method, `${this.partsBase()}${subpath}`, body);
  }

  private async requestAbs<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new InventoryApiError(res.status, "non_json", `Non-JSON response (${res.status})`);
    }
    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string; details?: unknown } }).error;
      throw new InventoryApiError(
        res.status,
        err?.code ?? "unknown",
        err?.message ?? `HTTP ${res.status}`,
        err?.details,
      );
    }
    return parsed as T;
  }

  /** Whether this instance presents its stock face or its lean catalog face,
   *  derived server-side from the instance's data (one-record-substrate.md). */
  getDisclosure = () =>
    this.partsRequest<{ stock: boolean; source: string }>("GET", "/disclosure");

  /** The sticky stock-tracking override for THIS instance, or undefined for
   *  "auto" (let the platform derive it from the data). Stored on the
   *  instance's entity-kind-override config; only meaningful for a named
   *  instance (the default is always stock). */
  getStockOverride = async (): Promise<boolean | undefined> => {
    if (!this.opts.instance) return undefined;
    const { items } = await this.requestAbs<{
      items: Array<{ target_kind: string; target_id: string; config?: Record<string, unknown> }>;
    }>("GET", `/api/v1/orgs/${this.slug}/entity-kind-overrides`);
    const row = items.find(
      (o) => o.target_kind === "instance" && o.target_id === `inventory:${this.opts.instance}`,
    );
    const v = row?.config?.stock;
    return typeof v === "boolean" ? v : undefined;
  };

  /** Force this instance to stock (true) or catalog (false), or clear the
   *  override (null = auto). Merges into the existing override config so
   *  item_noun / qty_unit are preserved. */
  setStockOverride = async (value: boolean | null): Promise<void> => {
    if (!this.opts.instance) return;
    const { items } = await this.requestAbs<{
      items: Array<{ target_kind: string; target_id: string; config?: Record<string, unknown> }>;
    }>("GET", `/api/v1/orgs/${this.slug}/entity-kind-overrides`);
    const row = items.find(
      (o) => o.target_kind === "instance" && o.target_id === `inventory:${this.opts.instance}`,
    );
    const config: Record<string, unknown> = { ...(row?.config ?? {}) };
    if (value === null) delete config.stock;
    else config.stock = value;
    await this.requestAbs("PUT", `/api/v1/orgs/${this.slug}/entity-kind-overrides`, {
      target_kind: "instance",
      target_id: `inventory:${this.opts.instance}`,
      config,
    });
  };

  /** The instance's item noun (singular + plural). Empty for the default
   *  instance. Defaulted from the collection name at creation, editable here. */
  getNouns = async (): Promise<{ singular?: string; plural?: string }> => {
    if (!this.opts.instance) return {};
    const { items } = await this.requestAbs<{
      items: Array<{ target_kind: string; target_id: string; config?: Record<string, unknown> }>;
    }>("GET", `/api/v1/orgs/${this.slug}/entity-kind-overrides`);
    const row = items.find(
      (o) => o.target_kind === "instance" && o.target_id === `inventory:${this.opts.instance}`,
    );
    return {
      singular: row?.config?.item_noun as string | undefined,
      plural: row?.config?.item_noun_plural as string | undefined,
    };
  };

  /** Rename what this instance calls its items. Merges into the override config
   *  so stock / qty_unit are preserved. */
  setNouns = async (singular: string, plural: string): Promise<void> => {
    if (!this.opts.instance) return;
    const { items } = await this.requestAbs<{
      items: Array<{ target_kind: string; target_id: string; config?: Record<string, unknown> }>;
    }>("GET", `/api/v1/orgs/${this.slug}/entity-kind-overrides`);
    const row = items.find(
      (o) => o.target_kind === "instance" && o.target_id === `inventory:${this.opts.instance}`,
    );
    const config: Record<string, unknown> = {
      ...(row?.config ?? {}),
      item_noun: singular.trim(),
      item_noun_plural: plural.trim(),
    };
    await this.requestAbs("PUT", `/api/v1/orgs/${this.slug}/entity-kind-overrides`, {
      target_kind: "instance",
      target_id: `inventory:${this.opts.instance}`,
      config,
    });
  };

  listCategories = () => this.request<{ items: Category[] }>("GET", "/categories");
  createCategory = (b: { name: string; color?: string; parent_id?: string | null }) =>
    this.request<Category>("POST", "/categories", b);

  // Locations now live in the foundational core-locations module —
  // /api/v1/orgs/:slug/modules/core-locations/locations. The inventory
  // UI still wants to show a location picker on parts, so we keep
  // these wrappers for callers' convenience.
  listLocations = () => this.requestAbs<{ items: Location[] }>(
    "GET",
    `/api/v1/orgs/${this.slug}/modules/core-locations/locations`,
  );
  /** Field defs for an entity kind — drives the parts table's custom-field
   *  columns (label + renderer). Org-level endpoint, not module-scoped. */
  // `effective` applies the user override layer (relabel / hide / reorder) — forms
  // + lists pass it; Settings (config) reads the raw defs to manage them.
  listFieldDefs = (kind: string, effective = false) => this.requestAbs<{ items: InvFieldDef[] }>(
    "GET",
    `/api/v1/orgs/${this.slug}/field-defs?kind=${encodeURIComponent(kind)}${effective ? "&effective=1" : ""}`,
  );
  /** Patch a field def — used to add a new option to a `choices` dropdown on
   *  the fly (e.g. a vendor not yet in the list). */
  updateFieldDef = (id: string, b: { choices?: string[]; display_label?: string }) => this.requestAbs<InvFieldDef>(
    "PATCH",
    `/api/v1/orgs/${this.slug}/field-defs/${id}`,
    b,
  );
  createLocation = (b: {
    name: string;
    short_name?: string | null;
    parent_id?: string | null;
    kind?: "container" | "area";
  }) => this.requestAbs<Location>(
    "POST",
    `/api/v1/orgs/${this.slug}/modules/core-locations/locations`,
    b,
  );

  listParts = (q: {
    search?: string;
    category_id?: string;
    location_id?: string;
    state?: "active" | "draft" | "needs_review";
    low_stock?: boolean;
    show_archived?: boolean;
    archived_only?: boolean;
    insured_only?: boolean;
    warranty_expires_within_days?: number;
    /** Lego-style lifecycle filter, see the API ListQuery comment. */
    lifecycle?: "bulk" | "kit" | "parted-out";
    cursor?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (q.search) params.set("search", q.search);
    if (q.category_id) params.set("category_id", q.category_id);
    if (q.location_id) params.set("location_id", q.location_id);
    if (q.state) params.set("state", q.state);
    if (q.low_stock) params.set("low_stock", "1");
    if (q.show_archived) params.set("show_archived", "1");
    if (q.archived_only) params.set("archived_only", "1");
    if (q.insured_only) params.set("insured_only", "1");
    if (q.warranty_expires_within_days)
      params.set("warranty_expires_within_days", String(q.warranty_expires_within_days));
    if (q.lifecycle) params.set("lifecycle", q.lifecycle);
    if (q.cursor) params.set("cursor", q.cursor);
    const qs = params.toString();
    return this.partsRequest<{ items: PartListItem[]; next_cursor: string | null }>(
      "GET",
      qs ? `?${qs}` : "",
    );
  };

  /** Builds the URL for the CSV export endpoint. The browser
   *  navigates to it (we can't fetch and download easily without a
   *  blob round-trip). Token has to come from the cookie — the API
   *  side accepts both. For Bearer-only clients, fetch the URL and
   *  pipe the blob to a download. */
  partsExportCsvUrl = (q: {
    search?: string;
    state?: "active" | "draft" | "needs_review";
    show_archived?: boolean;
    archived_only?: boolean;
    insured_only?: boolean;
  } = {}) => {
    const params = new URLSearchParams();
    if (q.search) params.set("search", q.search);
    if (q.state) params.set("state", q.state);
    if (q.show_archived) params.set("show_archived", "1");
    if (q.archived_only) params.set("archived_only", "1");
    if (q.insured_only) params.set("insured_only", "1");
    const qs = params.toString();
    return `${this.partsBase()}/export.csv${qs ? "?" + qs : ""}`;
  };

  /** Download the CSV by fetching with Bearer auth then saving the
   *  blob — works for any browser, no cookie required. */
  partsExportCsv = async (q: Parameters<typeof this.partsExportCsvUrl>[0] = {}) => {
    const url = this.partsExportCsvUrl(q);
    const token = this.opts.getToken();
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      throw new InventoryApiError(res.status, "csv_export_failed", `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    a.download = `inventory-${date}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  getPart = (id: string) => this.partsRequest<Part>("GET", `/${id}`);
  /** A consumable's ledger — what drew it down and how much, newest first. */
  listConsumption = (id: string) =>
    this.partsRequest<{ items: ConsumptionRow[] }>("GET", `/${id}/consumption`);

  // ── Spoolman: when present, it's the tracker; we pull a spool's remaining in. ──
  listSpoolman = () => this.request<{ items: SpoolmanConnection[] }>("GET", "/spoolman/connections");
  createSpoolman = (b: { label: string; base_url: string; api_key?: string }) =>
    this.request<SpoolmanConnection>("POST", "/spoolman/connections", b);
  deleteSpoolman = (id: string) => this.request<void>("DELETE", `/spoolman/connections/${id}`);
  syncSpoolman = (connection_id: string, instance?: string) =>
    this.request<{ ok: boolean; synced: number; created: number; updated: number }>("POST", "/spoolman/sync", {
      connection_id,
      instance,
    });
  /** The kinds inside an assortment, and adding one.
   *
   *  A kind IS a part: same table, same shape, just estimated and placed inside
   *  the assortment rather than loose in the bin. That is what lets one
   *  graduate into a counted item later without being re-entered, so this is
   *  deliberately createPart + place rather than a bespoke endpoint. */
  assortmentKinds = (assortmentId: string) =>
    this.requestAbs<{ items: Array<{ id: string; title: string; fields: Record<string, unknown> }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-placement/contents` +
        `?container_kind=${encodeURIComponent("inventory:part")}&container_id=${assortmentId}`,
    );

  /** Ask the record's photo what kinds are in there. Suggestion only. */
  suggestKinds = (assortmentId: string) =>
    this.partsRequest<{ kinds: Array<{ name: string; approximate_qty: number }> }>(
      "POST",
      `/${assortmentId}/suggest-kinds`,
    );

  addAssortmentKind = async (assortmentId: string, name: string, approximate: number) => {
    const kind = await this.createPart({ name, qty: 0, approximate_qty: approximate });
    await this.requestAbs("POST", `/api/v1/orgs/${this.slug}/modules/core-placement/place`, {
      containee: { kind: "inventory:part", id: kind.id },
      container: { kind: "inventory:part", id: assortmentId },
    });
    return kind;
  };

  createPart = (b: Partial<Omit<PartListItem, "id" | "created_at" | "updated_at" | "assigned_qty" | "available_qty" | "low_stock">> & { name: string }) =>
    this.partsRequest<Part>("POST", "", b);
  updatePart = (id: string, b: Record<string, unknown>) =>
    this.partsRequest<Part>("PATCH", `/${id}`, b);
  /** Change SOME custom fields, leaving the rest of the bag alone. Prefer this
   *  over `updatePart({ metadata })` for a single-field edit: that one replaces
   *  the whole bag, so it needs a local copy of every other field, and any copy
   *  taken from a list row is stale enough to revert a concurrent writer. */
  patchPartMetadata = (id: string, fields: Record<string, unknown>) =>
    this.partsRequest<Part>("PATCH", `/${id}/metadata`, fields);
  deletePart = (id: string) => this.partsRequest<void>("DELETE", `/${id}`);
  /** The units (serials) filed under this model. Each is a part in its own
   *  right — it links to its own detail. */
  listUnits = (id: string) =>
    this.partsRequest<{ items: Array<{ id: string; name: string; qty: string; serial_number: string | null; assigned_to: string | null; created_at: string }> }>(
      "GET",
      `/${id}/units`,
    );
  /** File a serial as a unit of this model. Does not touch the model's qty —
   *  see docs/design-decisions/within-instance-units.md. */
  mintUnit = (id: string, body: { serial_number?: string; name?: string }) =>
    this.partsRequest<{ id: string; name: string; serial_number: string | null }>("POST", `/${id}/units`, body);

  stockAdjust = (
    id: string,
    delta: number,
    reason?: string,
    source?: { source_kind?: string; source_id?: string },
  ) =>
    this.partsRequest<{ id: string; name: string; qty: number }>("POST", `/${id}/stock-adjust`, {
      delta,
      reason,
      ...(source?.source_kind ? { source_kind: source.source_kind } : {}),
      ...(source?.source_id ? { source_id: source.source_id } : {}),
    });
  importParts = (b: {
    csv: string;
    dry_run?: boolean;
    default_category_id?: string | null;
    default_location_id?: string | null;
  }) =>
    this.request<ImportResponse>("POST", "/parts/import", b);

  listAllocations = (q: { part_id?: string; status?: AllocationStatus } = {}) => {
    const params = new URLSearchParams();
    if (q.part_id) params.set("part_id", q.part_id);
    if (q.status) params.set("status", q.status);
    const qs = params.toString();
    return this.request<{ items: (Allocation & { part_name: string | null })[] }>(
      "GET",
      `/allocations${qs ? "?" + qs : ""}`,
    );
  };
  createAllocation = (b: {
    part_id: string;
    qty: number;
    target_module: string;
    target_entity_type: string;
    target_entity_id: string;
    reason?: string;
  }) => this.request<Allocation>("POST", "/allocations", b);
  setAllocationStatus = (id: string, status: "consumed" | "released") =>
    this.request<Allocation>("PATCH", `/allocations/${id}/status`, { status });

  /** Installed catalogs (id + schema) — enough to tell whether ANY catalog
   *  binds to inventory:part, which gates showing the quick-match typeahead on
   *  a skinned instance (e.g. Lego Sets) without adding an empty field to
   *  instances that have nothing to match against (e.g. a lone Yarn stash). */
  listCatalogs = () =>
    this.requestAbs<{
      items: Array<{
        id: string;
        schema?: { bindable_to_kinds?: string[]; field_map?: Record<string, string> } | null;
      }>;
    }>("GET", `/api/v1/orgs/${this.slug}/modules/core-catalogs/catalogs`);

  /** Cross-catalog search — returns hits from every installed catalog
   *  that has a title_column match against `q`. Used by the catalog-
   *  aware quick-add typeahead on NewPartDialog. Hosted catalogs are
   *  searched through the shared reference service.
   *
   *  source_kind=inventory:part keeps non-Lego catalogs out of the
   *  typeahead unless they explicitly declare bindable_to_kinds
   *  including inventory:part (or omit it). `prefer` (a catalog id) floats that
   *  catalog's hits to the top so a Sets form leads with sets, not minifigs. */
  searchCatalogs = (q: string, limit = 20, prefer?: string) =>
    this.requestAbs<{ items: CatalogSearchHit[] }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-catalogs/catalogs/search?${new URLSearchParams(
        { q, limit: String(limit), source_kind: "inventory:part", ...(prefer ? { prefer } : {}) },
      )}`,
    );

  /** Cross-kind entity search (core-search). Powers the reserve-for
   *  picker so users pick a real entity instead of typing a raw
   *  module / type / UUID. Each hit's `kind` is the "module:type" id. */
  searchEntities = (q: string, perKind = 8) =>
    this.requestAbs<{ items: Array<{ id: string; kind: string; title?: string; name?: string }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-search/search?${new URLSearchParams(
        { q, per_kind: String(perKind) },
      )}`,
    );

  /** Every module instance in this workspace (Yarn, Designs, Hooks…), across
   *  all modules. Used to word UI placeholders in the workspace's OWN
   *  vocabulary instead of hardcoded generic nouns — e.g. the reserve-for
   *  search hint reads "search a design, project…" on a yarn+design
   *  workspace. Read-only; safe to fail soft. */
  listWorkspaceInstances = () =>
    this.requestAbs<{ items: Array<{ module_name: string; instance_name: string; display_name: string }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/instances`,
    );

  /** Writes a `relationship_kind=matches` row in entity_pairings.
   *  Called after createPart() when the user picked a catalog hit on
   *  the quick-add form. */
  createMatchPairing = (source_id: string, catalog_entry_id: string) =>
    this.requestAbs<unknown>(
      "POST",
      `/api/v1/orgs/${this.slug}/pairings`,
      {
        source_kind: "inventory:part",
        source_id,
        target_kind: "core-catalogs:entry",
        target_id: catalog_entry_id,
        relationship_kind: "matches",
      },
    );

  /** Search items in a SPECIFIC instance — for the parent/"type" picker,
   *  which searches a different instance (e.g. the Spools form searching the
   *  Filament-types instance). Independent of this client's bound instance. */
  searchInstanceParts = (instance: string, q: string, limit = 8) =>
    this.requestAbs<{ items: Array<{ id: string; name: string; image_path: string | null; metadata?: Record<string, unknown> | null }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/instances/${encodeURIComponent(instance)}/items?search=${encodeURIComponent(q)}&limit=${limit}`,
    );

  /** The `instance-of` pairing: a unit (child) points at its "type" (parent),
   *  both inventory:part. Mirrors createMatchPairing but for a parent part. */
  createParentPairing = (child_id: string, parent_id: string) =>
    this.requestAbs<unknown>(
      "POST",
      `/api/v1/orgs/${this.slug}/pairings`,
      {
        source_kind: "inventory:part",
        source_id: child_id,
        target_kind: "inventory:part",
        target_id: parent_id,
        relationship_kind: "instance-of",
      },
    );

  /** This unit's current parent pairing(s), if any (newest first). Each row
   *  carries the pairing `id` (to delete) and `target_id` (the parent part). */
  listParentPairings = (child_id: string) =>
    this.requestAbs<{ items: Array<{ id: string; target_id: string }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/pairings?source_kind=inventory:part&source_id=${encodeURIComponent(child_id)}&relationship_kind=instance-of`,
    );

  /** Delete a pairing by id (used to re-link / unlink a unit's parent). */
  deletePairing = (pairing_id: string) =>
    this.requestAbs<unknown>("DELETE", `/api/v1/orgs/${this.slug}/pairings/${encodeURIComponent(pairing_id)}`);

  /** The reverse of listParentPairings: the `instance-of` CHILDREN of a model
   *  part (each `source_id` is a unit under this parent). Powers per-unit
   *  consumption's "which skeins are open under this model" lookup. */
  listChildPairings = (parent_id: string) =>
    this.requestAbs<{ items: Array<{ id: string; source_id: string }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/pairings?target_kind=inventory:part&target_id=${encodeURIComponent(parent_id)}&relationship_kind=instance-of`,
    );

  /** The RESOLVED view of an entity — the same platform read `CustomFieldsPanel`
   *  uses, so COMPUTED field values (e.g. a per-skein `capacity` derived from
   *  `{{ length_per_skein }}`) come back rendered under `.fields`. */
  lookupResolvedEntity = (kind: string, id: string) =>
    this.requestAbs<{ id: string; kind: string; title?: string; fields?: Record<string, unknown> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/entities/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
    );

  /** Mint a QR navigate-token for an entity. Used by NewPartDialog's
   *  "queue a label after create" flow. Cross-module call into
   *  labels' QR endpoint — kept here so callers don't reach for raw fetch. */
  mintQrToken = (b: {
    entity_kind: string;
    entity_id: string;
    mode: "navigate";
    auth: "session";
  }) =>
    // scan_url is the full URL to encode, built server-side from the
    // workspace's effective base (custom label base URL, else the serving
    // origin) — use it verbatim instead of guessing window.location.origin.
    this.requestAbs<{ token: string; scan_url: string }>(
      "POST",
      `/api/v1/orgs/${this.slug}/modules/labels/qr/tokens`,
      b,
    );

  /** Add an item to the labels print queue. Cross-module call into
   *  the labels module. */
  enqueueLabel = (b: {
    module_name: string;
    entity_type: string;
    entity_id: string;
    qr_payload: string;
    description: string;
    qty: number;
  }) =>
    this.requestAbs<unknown>(
      "POST",
      `/api/v1/orgs/${this.slug}/modules/labels/queue`,
      b,
    );
}

export interface CatalogSearchHit {
  id: string;
  catalog_id: string;
  catalog_name: string;
  external_id: string;
  payload: Record<string, unknown>;
  title: string;
  title_column: string;
  /** `{ catalogPayloadKey: instanceFieldName }` — declared on the catalog
   *  (schema.field_map). Picking this hit prefills those instance fields from
   *  the payload (e.g. Rebrickable set → set_number/theme/year/piece_count). */
  field_map?: Record<string, string>;
}
