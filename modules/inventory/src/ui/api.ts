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

export interface PartListItem {
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
}

export interface Part {
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const token = this.opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${this.base()}${path}`, {
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

  listLocations = () => this.request<{ items: Location[] }>("GET", "/locations");
  createLocation = (b: {
    name: string;
    short_name?: string | null;
    parent_id?: string | null;
    kind?: "container" | "area";
  }) => this.request<Location>("POST", "/locations", b);

  listParts = (q: {
    search?: string;
    category_id?: string;
    location_id?: string;
    state?: "active" | "draft" | "needs_review";
    low_stock?: boolean;
    cursor?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (q.search) params.set("search", q.search);
    if (q.category_id) params.set("category_id", q.category_id);
    if (q.location_id) params.set("location_id", q.location_id);
    if (q.state) params.set("state", q.state);
    if (q.low_stock) params.set("low_stock", "1");
    if (q.cursor) params.set("cursor", q.cursor);
    const qs = params.toString();
    return this.request<{ items: PartListItem[]; next_cursor: string | null }>(
      "GET",
      `/parts${qs ? "?" + qs : ""}`,
    );
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
}
