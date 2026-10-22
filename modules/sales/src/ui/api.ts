// Thin fetch wrapper for the sales REST surface + a generic part lookup (for
// line items). Routes mount at /api/v1/orgs/:slug/modules/sales/...

import type { IntakeSetting } from "../intake.js";
import type { LineAvailability } from "../availability.js";
import { describeUnreadableBody, noteWorkspaceWrite, workspaceFetch, uploadJson } from "@cobblr/platform-web";

export const orderWriteKey = (id: string) => ["sales-order-write", id] as const;

export type SalesOrderStatus = "draft" | "confirmed" | "fulfilled" | "shipped" | "closed" | "cancelled";

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}
export interface CustomerSummary extends Customer {
  order_count: number;
}

export interface SalesOrder {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  order_number: string | null;
  status: SalesOrderStatus;
  paid: boolean;
  paid_at?: string | null;
  auto_closed_at?: string | null;
  auto_close_undone?: boolean;
  order_date: string | null;
  /** When the customer wants it. */
  due_date?: string | null;
  fulfilled_at: string | null;
  carrier: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  /** When the carrier said the parcel was delivered ("Follow parcels I send"). */
  delivered_at?: string | null;
  shipping_address: string | null;
  source_name?: string | null;
  source_ref?: string | null;
  source_url?: string | null;
  notes: string | null;
  /** A bundle's custom fields on the order, by field name. */
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SalesOrderItem {
  metadata?: Record<string, unknown>;
  id: string;
  order_id: string;
  part_id: string | null;
  description: string | null;
  qty: string;
  /** How many have left stock so far. */
  qty_fulfilled: string;
  unit_price: string | null;
}

/** A work order made for this order (a planned build in Builds). */
export interface WorkOrderView {
  id: string;
  build_id: string;
  build_name: string;
  output_part_id: string | null;
  qty: number;
  made: number;
  status: string;
  /** The Make started for it in digifab, when there is one. */
  make_id?: string | null;
}

export interface SalesOrderDetail extends SalesOrder {
  items: SalesOrderItem[];
  total: number;
  /** Lines with no price; the total covers only the priced ones. */
  unpriced_lines?: number;
  other_currency_totals?: Record<string, number>;
  work_orders?: WorkOrderView[];
  availability?: LineAvailability[];
}

export interface PartOption {
  id: string;
  /** The kind it lives under: inventory's own or a named collection's. */
  kind?: string;
  title: string;
  subtitle?: string;
  /** The collection it is in, shown so two of the same name can be told apart. */
  collection?: string;
  /** The unit its count is kept in ("each", "m"): how much a line may ask for. */
  unit?: string | null;
}

/** A way on from a refused fulfilment: make the missing parts, or ship what
 *  is on hand now. */
export type FulfilDoor =
  | { kind: "make"; label: string; part_id: string; qty: number; href: string | null; line_id: string }
  | { kind: "ship_available"; label: string; qty: number }
  | { kind: "add_build"; label: string; href: string };

export interface ShipLookup {
  url: string;
  via: string;
  isCarrier: boolean;
}

/** What Ship will send the customer, and whether it can be emailed. */
export interface ShipPreview {
  notice: { to: string | null; subject: string; text: string };
  email: { available: boolean; from: string | null; reason: string | null };
  carrier: string | null;
  lookup: ShipLookup | null;
}

export interface ShipResult {
  order: SalesOrder;
  carrier: string | null;
  tracking_number: string | null;
  lookup: ShipLookup | null;
  notice: { to: string | null; subject: string; text: string };
  email: { asked: false } | { asked: true; sent: true; to: string; status: "sent" | "skipped" } | { asked: true; sent: false; reason: string };
}

export interface HistoryRow {
  id: string;
  kind: "status" | "stock" | "shipped" | "email" | "work_order";
  from_status: string | null;
  to_status: string | null;
  detail: Record<string, unknown>;
  by_user: string | null;
  by_name: string | null;
  created_at: string;
}

/** A list route's answer: this page, and how many there are in all. */
export interface Paged<T> {
  items: T[];
  total: number | null;
  complete: boolean;
}

/** "Follow parcels I send": whether it is on, whose connection it uses, and
 *  why the last round stopped short, if it did. */
export interface FollowParcels {
  close_delivered_orders: boolean;
  on: boolean;
  by: string | null;
  paused_until: string | null;
  paused_reason: "busy" | "quota_exhausted" | "not_connected" | "no_driver" | null;
  following?: number;
}

export type OrderSort = "newest" | "oldest" | "customer" | "number";

/** What a cancel did, and all an Undo needs to take it back. */
export interface CancelAnswer {
  ok: true;
  from: SalesOrderStatus;
  restocked: Array<{ line_id: string; part_id: string; qty: number }>;
}

export class SalesApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** What a refusal offers instead, when it offers anything. */
    public doors: FulfilDoor[] = [],
    /** The platform's blocked-action sheet already offers the remedy (an app
     *  to turn on, a permission to ask for), so this page adds no dialog. */
    public remedied = false,
  ) {
    super(message);
  }
}

export interface IntakeView { setting: IntakeSetting | null; connections: Array<{ id: string; label: string }> }

export class SalesApi {
  get workspace() { return this.slug; }
  async orderEmailAddress() { return this.parse<{ order_address: string | null; order_name?: string | null }>(await workspaceFetch(`/api/v1/orgs/${this.slug}/receipt-address`, { headers: this.headers() })); }
  /** Mail the person their orders address, from it, so their mail client learns "Cobblr Orders" (#5462). */
  async emailMyOrderAddress() { return this.parse<{ sent: boolean; to: string; name: string }>(await workspaceFetch(`/api/v1/orgs/${this.slug}/receipt-address/email-me`, { method: "POST", headers: this.headers(true), body: JSON.stringify({ which: "orders" }) })); }
  intake() { return this.req<IntakeView>("GET", "/intake"); }
  setIntake(config: { on: boolean; connection: string; mapping: Record<string, string> }) { return this.req<IntakeSetting>("PUT", "/intake", config); }
  checkIntake() { return this.req<IntakeSetting | null>("POST", "/intake/check", {}); }
  constructor(private readonly slug: string, private readonly getToken: () => string | null) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    const token = this.getToken();
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    let parsed: unknown;
    // TEXT first: res.json() CONSUMES the body, so once it throws the one
    // thing that says what went wrong is gone. See describeUnreadableBody.
    const raw = await res.text();
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SalesApiError(res.status, "non_json", describeUnreadableBody(res.status, raw));
    }
    if (!res.ok) {
      const body = parsed as { error?: { code?: string; message?: string; blocked?: unknown }; doors?: FulfilDoor[] };
      const e = body.error;
      throw new SalesApiError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`, Array.isArray(body.doors) ? body.doors : [], !!e?.blocked);
    }
    return parsed as T;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `/api/v1/orgs/${this.slug}/modules/sales${path}`;
    const res = await workspaceFetch(url, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = await this.parse<T>(res);
    if (method.toUpperCase() !== "GET") noteWorkspaceWrite(url, res);
    return out;
  }

  documents(id: string) { return this.req<DocumentList>("GET", `/orders/${id}/documents`); }
  prepareDocument(id: string, input: import("../documents.js").PrepareDocumentInput) { return this.req<{ document: DocumentRow; reused: boolean }>("POST", `/orders/${id}/documents`, input); }
  sendDocument(id: string, kind: "quote" | "invoice", version: string, to: string) { return this.req<{ ok: true; to: string; status: "sent" | "skipped" }>("POST", `/orders/${id}/documents/send`, { kind, version, to }); }
  async documentPdf(id: string, kind: "quote" | "invoice") {
    const res = await workspaceFetch(`/api/v1/orgs/${this.slug}/modules/sales/orders/${id}/documents/${kind}/pdf`, { headers: this.headers() });
    if (!res.ok) { await this.parse(res); throw new Error("The PDF could not be downloaded."); }
    return res.blob();
  }
  uploadLogo(file: File) {
    const form = new FormData(); form.append("file", file);
    return uploadJson<{ id: string }>(`/api/v1/orgs/${this.slug}/modules/core-files/files`, form, { token: this.getToken(), file });
  }

  // orders
  /** One page of orders and how many match. */
  listOrders(f: { q?: string; status?: SalesOrderStatus | ""; sort?: OrderSort; offset?: number; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (f.q) qs.set("q", f.q);
    if (f.status) qs.set("status", f.status);
    if (f.sort) qs.set("sort", f.sort);
    qs.set("offset", String(f.offset ?? 0));
    qs.set("limit", String(f.limit ?? 50));
    return this.req<Paged<SalesOrder>>("GET", `/orders?${qs}`);
  }
  getOrder(id: string) { return this.req<SalesOrderDetail>("GET", `/orders/${id}`); }
  createOrder(body: Partial<SalesOrder>) { return this.req<SalesOrder>("POST", "/orders", body); }
  updateOrder(id: string, body: Partial<SalesOrder>) { return this.req<SalesOrder>("PATCH", `/orders/${id}`, body); }
  deleteOrder(id: string) { return this.req<void>("DELETE", `/orders/${id}`); }
  fulfillOrder(id: string, ship: "all" | "available" = "all") {
    return this.req<{ order: SalesOrder; decremented: Array<{ part_id: string; qty: number }>; complete: boolean }>("POST", `/orders/${id}/fulfill`, { ship });
  }
  shipPreview(id: string, trackingNumber: string) {
    return this.req<ShipPreview>("GET", `/orders/${id}/ship-preview?tracking_number=${encodeURIComponent(trackingNumber)}`);
  }
  shipOrder(id: string, body: { tracking_number: string | null; carrier: string | null; email_customer: boolean }) {
    return this.req<ShipResult>("POST", `/orders/${id}/ship`, body);
  }
  makeLine(orderId: string, lineId: string, qty: number) {
    return this.req<{ ok: true; plannedId: string; buildName: string; qty: number; reused: boolean; makeId: string | null }>("POST", `/orders/${orderId}/items/${lineId}/make`, { qty });
  }
  orderHistory(id: string) { return this.req<{ items: HistoryRow[] }>("GET", `/orders/${id}/history`); }
  addItem(orderId: string, body: { part_id?: string | null; description?: string | null; qty: number; unit_price?: number | null; metadata?: Record<string, unknown> }) {
    return this.req<SalesOrderItem>("POST", `/orders/${orderId}/items`, body);
  }
  removeItem(orderId: string, itemId: string) { return this.req<void>("DELETE", `/orders/${orderId}/items/${itemId}`); }
  updateItem(orderId: string, itemId: string, body: { qty?: number; unit_price?: number | null; description?: string | null }) {
    return this.req<SalesOrderItem>("PATCH", `/orders/${orderId}/items/${itemId}`, body);
  }
  /** Cancel; a shipped order answers 409 ask_returned until returned is given. */
  cancelOrder(orderId: string, returned?: boolean) {
    return this.req<CancelAnswer>("POST", `/orders/${orderId}/cancel`, returned === undefined ? {} : { returned });
  }
  reinstateOrder(orderId: string, undo: CancelAnswer) {
    return this.req<{ ok: true }>("POST", `/orders/${orderId}/reinstate`, { from: undo.from, restocked: undo.restocked });
  }

  // customers
  /** One page of customers and how many match. */
  listCustomers(f: { q?: string; offset?: number; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (f.q) qs.set("q", f.q);
    qs.set("offset", String(f.offset ?? 0));
    qs.set("limit", String(f.limit ?? 50));
    return this.req<Paged<CustomerSummary>>("GET", `/customers?${qs}`);
  }
  getCustomer(id: string) { return this.req<CustomerSummary>("GET", `/customers/${id}`); }
  createCustomer(body: Partial<Customer>) { return this.req<Customer>("POST", "/customers", body); }
  updateCustomer(id: string, body: Partial<Customer>) { return this.req<Customer>("PATCH", `/customers/${id}`, body); }
  deleteCustomer(id: string) { return this.req<void>("DELETE", `/customers/${id}`); }

  // following sent parcels
  setCloseDelivered(on: boolean) { return this.req<{ on: boolean }>("PUT", "/follow-parcels/close-delivered", { on }); }
  undoDeliveryClose(orderId: string) { return this.req<{ undone: boolean }>("POST", `/orders/${orderId}/undo-delivery-close`, {}); }
  followParcels() { return this.req<FollowParcels>("GET", "/follow-parcels"); }
  setFollowParcels(on: boolean) { return this.req<FollowParcels>("PUT", "/follow-parcels", { on }); }
  checkParcelsNow() { return this.req<{ asked: number; delivered: number; stopped: string | null }>("POST", "/follow-parcels/check"); }

  /** Generic kernel entity search — inventory parts for the line-item picker. */
  async searchParts(q: string): Promise<PartOption[]> {
    const url = `/api/v1/orgs/${this.slug}/modules/sales/stock?q=${encodeURIComponent(q)}`;
    const res = await workspaceFetch(url, { headers: this.headers() });
    const data = await this.parse<{ items: Array<{ id: string; kind: string; title: string; subtitle?: string; collection: string; unit?: string | null }> }>(res);
    return data.items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, subtitle: i.subtitle, collection: i.collection, unit: i.unit ?? null }));
  }
}

export interface DocumentRow {
  id: string;
  kind: "quote" | "invoice";
  number: string;
  revision: string;
  snapshot: import("../invoice.js").SalesDocument;
  created_at: string;
}
export interface DocumentList {
  items: DocumentRow[];
  shop_name: string;
  email: { to: string | null; from: string | null; available: boolean; reason: string | null };
}
