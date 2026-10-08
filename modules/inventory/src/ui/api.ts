import type { ReceiptDraftConfig, RenewalReceiptDraft } from "@cobblr/platform-contract/record-creation";
import type { StockView, ConfigureStock, ConsumeStock, LoadStock } from "../api/stock-shapes";
import type { z } from "zod";
export type StockDetail = StockView & { uses: Array<{ id: string; source: string; verdict: string; amount: string; unit: string; at: string }>; loaded: { station: string; slot: string } | null };
import type { storageView } from "../api/storage";
export type StorageView = NonNullable<Awaited<ReturnType<typeof storageView>>>;
import type { SheetChange, sheetView } from "../api/sheets";
export type SheetView = NonNullable<ReturnType<typeof sheetView>>;
import type { MaterialNumbers } from "../material-numbers";
export interface MaterialView extends MaterialNumbers {
  spool_id: number;
  empty_spool_g: number | null;
  place: { kind: string; id: string } | null;
  jobs: Array<{ reason: string | null }>;
  tracked_by: string | null;
}
// Thin fetch wrapper scoped to the inventory module's REST surface.
// The host app provides the auth token via getToken(); we just build
// URLs and parse responses.
//
// Each method takes the org slug because the module's routes are
// mounted at /api/v1/orgs/:slug/modules/inventory/... — the platform
// pre-applies auth + tenant resolution on every request.

import type { NounChoiceDecl } from "@cobblr/platform-contract/kind-label";
import type { CardRollup } from "@cobblr/platform-contract/holdings";
import type { FieldRendererId, FieldType } from "@cobblr/platform-web";
import { describeUnreadableBody, noteWorkspaceWrite } from "@cobblr/platform-web";
import { downloadBlob } from "@cobblr/platform-web";
import { dayHere } from "@cobblr/platform-contract/day";
import type { PartFacets } from "./list-filters";

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
  /** Asked for on the New form; once filled, an edit cannot empty it. */
  required?: boolean | null;
  /** type='relation' only: the referenced entity-kind id. */
  ref_kind?: string | null;
  /** type='computed' only: the {{ }} template rendered read-only server-side.
   *  Per-unit consumption reads this to detect a DERIVED capacity + its source
   *  field for the provenance chip. */
  template?: string | null;
  entity_kind?: string;
  bundle_id?: string | null;
  source_module?: string | null;
  decode_role?: string | null;
  field_role?: string | null;
  /** A person's new value is remembered as a choice (see field-choices). */
  learns?: boolean | null;
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
  /** The stored name: what the source spelt, what the edit form writes. */
  name: string;
  /** How the title READS for this person, when the server composed one (a
   *  titled work's forms through their preference, #3061). Shown in place
   *  of `name`, never written: nothing composed is ever writable. */
  title?: string;
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
  /** Installed in an asset or machine (2 sticks in a computer), and in what.
   *  Absent on an older response. */
  installed_qty?: number;
  /** On hand: not installed. Hide unavailable hides a row where this is 0. */
  spare_qty?: number;
  installed_in?: Array<{ kind: string; id: string; name: string; qty: number }>;
  /** What is on hand in the count's units: the unopened count plus every
   *  open unit still holding something. `low_stock` is judged on this, so an
   *  open skein with metres left is not "out". Absent on an older response. */
  on_hand?: number;
  /** The open units of a model tracked unit by unit, each with what is left
   *  in it; null when nothing is open. The list shows "1 open · 160 m"
   *  beside the count instead of a 0 that reads as no yarn. */
  open_units?: { count: number; remaining: Array<{ id: string; qty: number; unit: string | null }> } | null;
  /** How many UNITS (serials) this model has on file. Derived server-side, and
   *  batched for the whole page. Absent on an older response; 0 means the model
   *  isn't serialized. The list uses it only for the passive "not yet scanned"
   *  chip — the reconciliation QUESTION lives on the detail, where it can be
   *  answered. See docs/design-decisions/serialized-rollup-and-stock-adjust.md. */
  units_count?: number;
  /** Computed: positive = days until expiry, negative = already
   *  expired, null = no warranty date. */
  warranty_days_until: number | null;
  /** When this thing is kept in several places: a row per place, its own
   *  first (docs/design-decisions/holdings-and-units.md). Absent for a record
   *  kept in one place, and in the flat view. */
  holdings?: HoldingRow[];
  /** The card's top line over those rows. */
  rollup?: CardRollup;
}

/** One place a thing is kept, as the card's row shows it. */
export interface HoldingRow {
  id: string;
  own: boolean;
  location_id: string | null;
  location_name: string | null;
  qty: number;
  min_qty: number | null;
  low: boolean;
  expires_on: string | null;
  /** The lots held here, soonest first; empty when nothing is dated. */
  lots?: HoldingLot[];
}

/** One lot at one place: how many, when it arrived, when it goes off, and the
 *  lot number printed on it when there is one. */
export interface HoldingLot {
  received_on: string;
  expires_on: string;
  qty: number;
  lot?: string;
}

export interface Part extends HomeBoxFields {
  id: string;
  name: string;
  /** How the title READS for this person (served, never written; #3061). */
  title?: string;
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
  unit?: string | null;
  id: string;
  delta: string; // signed: negative = consumed
  reason: string | null;
  source_kind: string | null;
  source_id: string | null;
  /** Who did it, by the name they go by now; null when nobody did by hand or
   *  they have left the workspace. */
  by_name?: string | null;
  by_user?: string | null;
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
  /** The table's own fields (author, expiry...), by field name. */
  metadata?: Record<string, unknown>;
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
  uploadReceipt = (file: File) => {
    const form = new FormData(); form.set("file", file);
    return this.requestAbs<{ id: string }>("POST", `/api/v1/orgs/${this.slug}/modules/core-files/files`, form);
  };
  receiptItems = () => this.requestAbs<{ items: Array<{ id: string; suggested_name: string | null; source_kind: string }> }>("GET", `/api/v1/orgs/${this.slug}/modules/core-scan/inbox?status=pending&limit=200`);
  renewalDraft = async (source: { file_id?: string; inbox_id?: string }, target_kind: string, binding: ReceiptDraftConfig): Promise<RenewalReceiptDraft> => {
    const answer = await this.requestAbs<{ result: { ok: boolean; error?: string; result: RenewalReceiptDraft } }>("POST", `/api/v1/orgs/${this.slug}/actions/invoke`, { actionId: "core-scan:renewal-draft", args: { ...source, target_kind, binding } });
    if (!answer.result.ok) throw new Error(answer.result.error ?? "Couldn't draft from this receipt");
    return answer.result.result;
  };
  createLinkedRecord = (kind: string, name: string) => this.requestAbs<{ id: string }>("POST", `/api/v1/orgs/${this.slug}/instances/${encodeURIComponent(kind.split(":")[0]!)}/items`, { name });
  attachReceipt = (file_id: string, id: string) => this.requestAbs("POST", `/api/v1/orgs/${this.slug}/modules/core-files/attachments`, { file_id, source_module: "inventory", source_type: "part", source_id: id, role: "receipt" });
  paste(id: string) { return this.partsRequest<import("../api/paste.js").PasteView>("GET", `/${id}/paste`); }
  storage = (id: string) => this.partsRequest<StorageView | null>("GET", `/${id}/storage`);
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
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const token = this.opts.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
    const wrote = method.toUpperCase() !== "GET";

    if (res.status === 204) {
      if (wrote) noteWorkspaceWrite(url, res);
      return undefined as T;
    }
    let parsed: unknown;
    // TEXT first: res.json() CONSUMES the body, so once it throws the one
    // thing that says what went wrong is gone. See describeUnreadableBody.
    const raw = await res.text();
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InventoryApiError(res.status, "non_json", describeUnreadableBody(res.status, raw));
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
    if (wrote) noteWorkspaceWrite(url, res);
    return parsed as T;
  }

  /** Whether this instance presents its stock face or its lean catalog face,
   *  derived server-side from the instance's data (one-record-substrate.md). */
  getDisclosure = () =>
    this.partsRequest<{ stock: boolean; source: string }>("GET", "/disclosure");

  /** Which list filters this table's records can use (list-filters.ts). */
  getPartFacets = () => this.partsRequest<PartFacets>("GET", "/facets");

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
  getNouns = async (): Promise<{ singular?: string; plural?: string; offer?: NounChoiceDecl; choice?: string }> => {
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
      // A bundle that offers words for this table (#3650), and the one picked.
      offer: (row?.config?.noun ?? undefined) as NounChoiceDecl | undefined,
      choice: (row?.config?.noun_choice as { singular?: string } | null | undefined)?.singular,
    };
  };

  /** Pick one of the words the table's bundle offers. The platform re-applies
   *  the bundle, so every label says it and records on the old unit follow. */
  setOfferedNoun = async (singular: string): Promise<void> => {
    if (!this.opts.instance) return;
    await this.requestAbs("PUT", `/api/v1/orgs/${this.slug}/bundles/noun`, { instance: this.opts.instance, singular });
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
  getLowStockAlerts = () => this.request<{ enabled: boolean; canManage: boolean }>("GET", "/low-stock-alerts");
  setLowStockAlerts = (enabled: boolean) => this.request<{ enabled: boolean; canManage: boolean }>("PUT", "/low-stock-alerts", { enabled });
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
    /** Leave out rows with nothing on hand (all installed, or none left). */
    hide_unavailable?: boolean;
    show_archived?: boolean;
    archived_only?: boolean;
    insured_only?: boolean;
    /** Only records with a required field still empty. */
    needs_value?: boolean;
    /** Only records holding a value that does not fit its field. */
    doesnt_fit?: boolean;
    warranty_expires_within_days?: number;
    /** Lego-style lifecycle filter, see the API ListQuery comment. */
    lifecycle?: "bulk" | "kit" | "parted-out";
    /** "flat": one line per place instead of one card per thing. */
    rows?: "flat";
    cursor?: string;
    /** A saved view's own query (filter / where / sort), see viewQuery. */
    filter?: Record<string, unknown>;
    where?: unknown[];
    sort?: string[];
  } = {}) => {
    const params = new URLSearchParams();
    // This browser's day: a view's "today" (a "Ready to drink" window) is the
    // reader's, and the server cannot tell it from a UTC clock.
    params.set("today", dayHere());
    if (q.search) params.set("search", q.search);
    if (q.filter && Object.keys(q.filter).length) params.set("filter", JSON.stringify(q.filter));
    if (q.where && q.where.length) params.set("where", JSON.stringify(q.where));
    if (q.sort && q.sort.length) params.set("sort", q.sort.join(","));
    if (q.hide_unavailable) params.set("hide_unavailable", "1");
    if (q.category_id) params.set("category_id", q.category_id);
    if (q.location_id) params.set("location_id", q.location_id);
    if (q.state) params.set("state", q.state);
    if (q.low_stock) params.set("low_stock", "1");
    if (q.show_archived) params.set("show_archived", "1");
    if (q.archived_only) params.set("archived_only", "1");
    if (q.insured_only) params.set("insured_only", "1");
    if (q.needs_value) params.set("needs_value", "1");
    if (q.doesnt_fit) params.set("doesnt_fit", "1");
    if (q.warranty_expires_within_days)
      params.set("warranty_expires_within_days", String(q.warranty_expires_within_days));
    if (q.lifecycle) params.set("lifecycle", q.lifecycle);
    if (q.rows) params.set("rows", q.rows);
    if (q.cursor) params.set("cursor", q.cursor);
    const qs = params.toString();
    return this.partsRequest<{ items: PartListItem[]; next_cursor: string | null; unapplied?: Array<{ col: string; op: string; value?: unknown; ref_col?: string }> }>(
      "GET",
      qs ? `?${qs}` : "",
    );
  };

  /** How many of this list's records have a required field still empty. */
  partsNeedsValue = () => this.partsRequest<{ count: number; fields: string[] }>("GET", "/needs-value");

  /** How many of this list's records hold a value that does not fit its field. */
  partsDoesntFit = () => this.partsRequest<{ count: number; fields: Array<{ label: string; count: number }> }>("GET", "/doesnt-fit");

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
    // UTC-DAY OK: the download filename's stamp, not a claim about anybody's calendar.
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `inventory-${date}.csv`);
    return { secretsOmitted: res.headers.get("x-export-secrets") === "omitted" };
  };
  getPart = (id: string) => this.partsRequest<Part>("GET", `/${id}`);
  /** A consumable's ledger — what drew it down and how much, newest first. */
  stockShape = (id: string) => this.request<StockDetail>("GET", `/stock/shapes/${id}`);
  configureStock = (id: string, body: z.input<typeof ConfigureStock>) => this.request<{ warning?: string }>("PATCH", `/stock/shapes/${id}`, body);
  consumeStock = (id: string, body: z.input<typeof ConsumeStock>) => this.request<{ warning?: string }>("POST", `/stock/shapes/${id}/consume`, body);
  loadStock = (id: string, body: z.input<typeof LoadStock>) => this.request<unknown>("POST", `/stock/shapes/${id}/load`, body);
  sheet = (id: string) => this.partsRequest<SheetView | null>("GET", `/${id}/sheet`);
  changeSheet = (id: string, body: SheetChange) => this.partsRequest<SheetView>("POST", `/${id}/sheet`, body);
  findSheets = (body: Partial<{ material: string; thickness_mm: number; width_mm: number; height_mm: number; rotate: boolean; offset: number }>) => this.request<{ items: SheetView[]; total: number }>("GET", `/sheets/find?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))}`);
  material = (id: string) => this.partsRequest<MaterialView | null>("GET", `/${id}/material`);
  measureMaterial = (id: string, body: { gross_g?: number; used_mm?: number }) =>
    this.partsRequest<unknown>("POST", `/${id}/material`, body);
  listConsumption = (id: string) =>
    this.partsRequest<{ items: ConsumptionRow[] }>("GET", `/${id}/consumption`);

  searchFilamentCatalog = (q: string) => this.request<{ items: Array<{ id: string; manufacturer: string; name: string; material: string }>; total: number }>("GET", `/filament-catalog?q=${encodeURIComponent(q)}`);
  importFilamentType = (catalog_id: string) => this.request<{ id: string }>("POST", "/filament-catalog", { catalog_id });

  // ── Spoolman: when present, it's the tracker; we pull a spool's remaining in. ──
  listSpoolman = () => this.request<{ items: SpoolmanConnection[] }>("GET", "/spoolman/connections");
  createSpoolman = (b: { label: string; base_url: string; api_key?: string }) =>
    this.request<SpoolmanConnection>("POST", "/spoolman/connections", b);
  deleteSpoolman = (id: string) => this.request<void>("DELETE", `/spoolman/connections/${id}`);
  syncSpoolman = (connection_id: string, instance?: string, authority?: "spoolman" | "cobblr") =>
    this.request<{ ok: boolean; synced: number; created: number; updated: number }>("POST", "/spoolman/sync", {
      connection_id, authority,
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

  /** Records that hold things and are not places by nature (a Backpack): a
   *  part can be kept inside one, offered beside the places. */
  listHolders = () =>
    this.requestAbs<{ items: Array<{ kind: string; id: string; title: string; line: string }> }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-placement/holders`,
    );

  /** Where a part is, every step up ("Backpack, in Desk drawer"). */
  partPath = (id: string) =>
    this.requestAbs<{ path: Array<{ kind: string; id: string; name: string }>; line: string; inside?: { kind: string; id: string; name: string } | null }>(
      "GET",
      `/api/v1/orgs/${this.slug}/modules/core-placement/path?containee_kind=${encodeURIComponent("inventory:part")}&containee_id=${id}`,
    );

  /** Put a part inside something, a place or a holder, through placement. */
  placePart = (id: string, container: { kind: string; id: string }) =>
    this.requestAbs("POST", `/api/v1/orgs/${this.slug}/modules/core-placement/place`, {
      containee: { kind: "inventory:part", id },
      container,
    });

  /** Take a part out of whatever holds it. */
  unplacePart = (id: string) =>
    this.requestAbs("POST", `/api/v1/orgs/${this.slug}/modules/core-placement/remove`, {
      containee: { kind: "inventory:part", id },
    });

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

  /** Lots going off within `within` days across every collection, grouped by
   *  place, soonest first (module-level: not scoped to one collection). */
  /** What of THIS collection goes off soon (never another collection's). */
  stockExpiring = (within = 30) =>
    this.request<StockExpiring>("GET", `/stock/expiring?within=${within}&today=${dayHere()}&collection=${encodeURIComponent(this.opts.instance ?? "inventory")}`);
  /** The places this thing is kept, its own first, and the card's top line. */
  listHoldings = (id: string) =>
    this.partsRequest<{ card_id: string; rows: HoldingRow[]; rollup: CardRollup }>("GET", `/${id}/holdings`);
  /** Keep it in one more place. */
  addHolding = (id: string, body: { location_id: string; qty?: number; min_qty?: number | null }) =>
    this.partsRequest<{ id: string; card_id: string }>("POST", `/${id}/holdings`, body);
  /** These records are the same thing kept elsewhere: rows of this card. */
  combineHoldings = (id: string, ids: string[]) =>
    this.partsRequest<{ card_id: string; combined: string[] }>("POST", `/${id}/holdings/combine`, { ids });
  /** Move stock from this place to another place of the same item (or a
   *  location it is not kept at yet): soonest-expiring first unless a lot is
   *  named, every lot keeping its expiry and number. */
  transferStock = (fromId: string, body: { to_id?: string; to_location_id?: string; qty: number; lot?: string; expires_on?: string }) =>
    this.partsRequest<{ from_id: string; to_id: string; qty: number; moved: HoldingLot[] }>("POST", `/${fromId}/transfer`, body);
  /** Stock arrived here, with the expiry printed on it and its lot number. */
  receiveLot = (id: string, body: { qty: number; expires_on?: string | null; lot?: string | null }) =>
    this.partsRequest<Record<string, unknown>>("POST", `/${id}/receive`, body);
  /** Records that look like one thing kept in several places (the same name
   *  or barcode, each somewhere else): offered, never combined on their own.
   *  `forId` narrows to the group holding that record. */
  combineSuggestions = (forId?: string) =>
    this.partsRequest<{ items: CombineSuggestion[] }>("GET", `/holdings/suggestions${forId ? `?for=${forId}` : ""}`);
  /** "These are different things": the suggestion stops asking about them. */
  notTheSame = (ids: string[]) =>
    this.partsRequest<{ ok: true }>("POST", `/holdings/suggestions/not-the-same`, { ids });
  /** A place's stock becomes a record of its own again. */
  splitHolding = (cardId: string, holdingId: string) =>
    this.partsRequest<{ id: string }>("POST", `/${cardId}/holdings/${holdingId}/split`, {});
  /** The type collection read with its things under each type (Filament):
   *  families.ts GET /family/all. */
  familyAll = () => this.partsRequest<FamilyPayload>("GET", "/family/all");
  /** A thing under a type, or under a new type named here. */
  addToFamily = (body: { type_id?: string; new_type?: { name: string; manufacturer?: string | null; metadata?: Record<string, unknown> }; qty?: number; unit?: string | null; location_id?: string | null }) =>
    this.partsRequest<{ id: string; type_id: string }>("POST", "/family/children", body);
  /** One tap on a thing in ANOTHER collection of this family (a spool from
   *  the Filament page): the ledgered stock adjust on that record's own door. */
  stockAdjustIn = (instance: string, id: string, delta: number) =>
    this.requestAbs<{ id: string; name: string; qty: number }>("POST", `/api/v1/orgs/${this.slug}/instances/${encodeURIComponent(instance)}/items/${id}/stock-adjust`, { delta });

  /** Delete a record in ANOTHER collection of this family (a spool from the
   *  Filament page), through that collection's own door. */
  deleteIn = (instance: string, id: string) =>
    this.requestAbs<void>("DELETE", `/api/v1/orgs/${this.slug}/instances/${encodeURIComponent(instance)}/items/${id}`);

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
    // Through partsBase, so a Bookshelf's Import lands on the bookshelf.
    this.partsRequest<ImportResponse>("POST", "/import", b);

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

  /** One item of a SPECIFIC instance (a spool's type lives in the types
   *  collection, not the spool's own). */
  getInstancePart = (instance: string, id: string) =>
    this.requestAbs<Part>("GET", `/api/v1/orgs/${this.slug}/instances/${encodeURIComponent(instance)}/items/${encodeURIComponent(id)}`);
  /** Move a thing to another type: the family's own door (a Links row cannot
   *  remove the link to a thing's type). */
  setFamilyType = (childId: string, typeId: string) =>
    this.partsRequest<{ id: string; type_id: string; type_name: string }>("POST", `/family/children/${encodeURIComponent(childId)}/type`, { type_id: typeId });

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

export interface FamilyThing {
  material?: (MaterialNumbers & { jobs: number }) | null;
  id: string;
  name: string;
  qty: number;
  unit: string | null;
  min_qty: number | null;
  low: boolean;
  location_id: string | null;
  location_name?: string | null;
  image_path: string | null;
  metadata: Record<string, unknown>;
}

export interface FamilyType {
  id: string;
  name: string;
  manufacturer: string | null;
  image_path: string | null;
  metadata: Record<string, unknown>;
  children: FamilyThing[];
  count: number;
  remaining: number;
  low: boolean;
}

export interface FamilyPayload {
  package_receiving?: { identity_field: string; storage_tracking: boolean } | null;
  parent: string;
  child: string;
  child_noun: string | null;
  parent_noun: string | null;
  /** The unit a new thing is counted in ("kg"), when the collection says. */
  child_unit?: string | null;
  types: FamilyType[];
  unclaimed: FamilyThing[];
  counts: { types: number; children: number; low: number };
  /** What this read carried, when the family is bigger than one read. */
  shown?: { types: number; children: number };
  complete?: boolean;
}

/** Lots going off soon, wherever they are. */
export interface StockExpiring {
  today: string;
  within: number;
  places: Array<{
    location_id: string | null;
    location_name: string | null;
    lots: Array<{ part_id: string; card_id: string | null; name: string; instance: string; kind: string; detail_path: string; qty: number; unit: string; lot: string | null; expires_on: string; days: number }>;
  }>;
}

/** Records that look like one thing kept in several places. */
export interface CombineSuggestion {
  because: "the same name" | "the same barcode";
  records: Array<{ id: string; name: string; location_id: string | null; location_name: string | null; qty: number; places: number }>;
}
