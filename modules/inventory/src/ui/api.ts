// Thin fetch wrapper scoped to the inventory module's REST surface.
// The host app provides the auth token via getToken(); we just build
// URLs and parse responses.
//
// Each method takes the org slug because the module's routes are
// mounted at /api/v1/orgs/:slug/modules/inventory/... — the platform
// pre-applies auth + tenant resolution on every request.

export type AllocationStatus = "reserved" | "consumed" | "released";

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
}

export class InventoryApi {
  constructor(private readonly slug: string, private readonly opts: InventoryApiOptions) {}

  private base(): string {
    return `/api/v1/orgs/${this.slug}/modules/inventory`;
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestAbs<T>(method, `${this.base()}${path}`, body);
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
    return this.request<{ items: PartListItem[]; next_cursor: string | null }>(
      "GET",
      `/parts${qs ? "?" + qs : ""}`,
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
    return `${this.base()}/parts/export.csv${qs ? "?" + qs : ""}`;
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
  getPart = (id: string) => this.request<Part>("GET", `/parts/${id}`);
  createPart = (b: Partial<Omit<PartListItem, "id" | "created_at" | "updated_at" | "assigned_qty" | "available_qty" | "low_stock">> & { name: string }) =>
    this.request<Part>("POST", "/parts", b);
  updatePart = (id: string, b: Record<string, unknown>) =>
    this.request<Part>("PATCH", `/parts/${id}`, b);
  deletePart = (id: string) => this.request<void>("DELETE", `/parts/${id}`);
  stockAdjust = (id: string, delta: number, reason?: string) =>
    this.request<{ id: string; name: string; qty: number }>("POST", `/parts/${id}/stock-adjust`, {
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
