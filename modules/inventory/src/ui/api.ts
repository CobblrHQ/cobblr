// Thin fetch wrapper scoped to the inventory module's REST surface.
// The host app provides the auth token via getToken(); we just build
// URLs and parse responses.
//
// Each method takes the org slug because the module's routes are
// mounted at /api/v1/orgs/:slug/modules/inventory/... — the platform
// pre-applies auth + tenant resolution on every request.

export type AllocationStatus = "reserved" | "consumed" | "released";

/** Subset of a platform field-def the parts table needs to render custom
 *  columns (label + value renderer). Mirrors @cobblr/platform-web's
 *  PlatformFieldDef without taking a cross-package dep. */
export interface InvFieldDef {
  id: string;
  name: string;
  display_label: string;
  type: string;
  position: number;
  choices?: string[] | null;
  renderer?: string | null;
  /** Plain-language one-line hint shown under the input. */
  help?: string | null;
  /** Server-managed: value stamped server-side; never render an input. */
  server_managed?: boolean | null;
  /** type='relation' only: the referenced entity-kind id. */
  ref_kind?: string | null;
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
  updateFieldDef = (id: string, b: { choices?: string[] }) => this.requestAbs<InvFieldDef>(
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
  createPart = (b: Partial<Omit<PartListItem, "id" | "created_at" | "updated_at" | "assigned_qty" | "available_qty" | "low_stock">> & { name: string }) =>
    this.partsRequest<Part>("POST", "", b);
  updatePart = (id: string, b: Record<string, unknown>) =>
    this.partsRequest<Part>("PATCH", `/${id}`, b);
  deletePart = (id: string) => this.partsRequest<void>("DELETE", `/${id}`);
  stockAdjust = (id: string, delta: number, reason?: string) =>
    this.partsRequest<{ id: string; name: string; qty: number }>("POST", `/${id}/stock-adjust`, {
      delta,
      reason,
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

  /** Cross-catalog search — returns hits from every installed catalog
   *  that has a title_column match against `q`. Used by the catalog-
   *  aware quick-add typeahead on NewPartDialog.
   *
   *  source_kind=inventory:part keeps non-Lego catalogs out of the
   *  typeahead unless they explicitly declare bindable_to_kinds
   *  including inventory:part (or omit it). */
  searchCatalogs = (q: string, limit = 20) =>
    this.requestAbs<{ items: CatalogSearchHit[] }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-catalogs/catalogs/search?${new URLSearchParams(
        { q, limit: String(limit), source_kind: "inventory:part" },
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

  /** Mint a QR navigate-token for an entity. Used by NewPartDialog's
   *  "queue a label after create" flow. Cross-module call into
   *  core-labels-qr — kept here so callers don't reach for raw fetch. */
  mintQrToken = (b: {
    entity_kind: string;
    entity_id: string;
    mode: "navigate";
    auth: "session";
  }) =>
    this.requestAbs<{ token: string }>(
      "POST",
      `/api/v1/orgs/${this.slug}/modules/core-labels-qr/tokens`,
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
}
