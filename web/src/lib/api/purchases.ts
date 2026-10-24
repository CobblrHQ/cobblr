import type { MoneyTotal } from "@cobblr/platform-contract/money";
import { primaryBase, request } from "./client";

export interface Vendor {
  id: string;
  name: string;
  website: string | null;
  account_number: string | null;
  contact: string | null;
  lead_time_days: number | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface VendorSummary extends Vendor {
  order_count: number;
  total_spend: number;
}

export interface VendorDetail extends Vendor {
  currency?: string;
  money_total?: MoneyTotal;
  orders: Array<Pick<Order, "stock_pending" | "currency" | "money_total" | "id" | "order_number" | "status" | "ordered_at" | "expected_arrival" | "arrived_at" | "total_cost" | "total">>;
  order_count: number;
  total_spend: number;
}

export type ReturnStage = "requested" | "dropped_off" | "received" | "refunded" | "cancelled";

/** A return on an order (#4250): its furthest stage, the refund, and whether
 *  its count has left the shelf. */
export interface OrderReturn {
  id: string;
  order_id: string;
  line_id: string | null;
  item: string | null;
  qty: number;
  reason: string | null;
  stage: ReturnStage;
  refund_amount: number | null;
  refunded_at: string | null;
  off_shelf: boolean;
  history: Array<{ stage: ReturnStage; at: string; source: "person" | "email" | "assistant"; ignored?: boolean }>;
  created_at: string;
}

export interface Order {
  stock_pending?: boolean;
  computed_total?: number;
  computed_subtotal?: number;
  shipping_total?: number;
  shipping_currency?: string;
  currency?: string;
  money_total?: MoneyTotal;
  id: string;
  vendor: string | null;
  vendor_id: string | null;
  order_number: string | null;
  url: string | null;
  ordered_at: string | null;
  expected_arrival: string | null;
  arrived_at: string | null;
  status: "planned" | "ordered" | "in-transit" | "arrived" | "cancelled";
  /** The figure somebody stated (a receipt's total, typed in). */
  total_cost: string | null;
  /** What the order cost: the stated total, else its lines plus shipping.
   *  Every spend figure reads this (order-total.ts); null when nothing on
   *  the order has a price. */
  total?: string | null;
  /** What came back in refunds; already taken off `total`. Detail only. */
  refunded?: number | null;
  shipping_cost: string | null;
  tracking_number: string | null;
  /** Where the parcel is, written by the arrival sweep. Null until something
   *  has been followed — a tracking number with no state has not been asked
   *  about yet, which is a different thing from "no information". */
  shipment_state: string | null;
  shipment_checked_at: string | null;
  /** Whether the lines add their stock when the order arrives. Off for a
   *  past purchase being logged, whose stock was counted long ago. */
  add_to_stock?: boolean;
  notes: string | null;
  metadata: Record<string, unknown>;
  /** Line-item count — present on the list endpoint (GET /orders), absent on detail. */
  item_count?: number;
  /** The parcels an order ships in when it ships in more than one (detail
   *  only). A line names its own by shipment_id; a line with none travels
   *  under the order's own tracking_number. */
  shipments?: OrderShipment[];
  /** The store's own order page, when an order email carried its link
   *  (detail only). Never the link itself. */
  order_page?: OrderPage | null;
  created_at: string;
  updated_at: string;
}

/** How following the store's own order page is going (#5461). */
export interface OrderPage {
  /** The store's host, e.g. shop.example.org. */
  store: string;
  state: "waiting" | "following" | "done" | "expired" | "redacted" | "unsupported" | string;
  last_read_at: string | null;
  /** How many lines the page said had shipped, at the last read. */
  shipped_lines: number | null;
  /** Whether this instance reads store pages at all. */
  reads_on: boolean;
}

/** What purchases did with a parcel (POST /orders/:id/shipments). */
export interface ShipmentOutcome {
  mode: "order" | "shipment";
  shipment_id: string | null;
  tracking_number: string;
  lines: Array<{ id: string; description: string | null }>;
  not_shipped: Array<{ id: string; description: string | null }>;
  created: boolean;
}

/** A line still to arrive for one record, with its parcel when it has one. */
export interface IncomingLine {
  line_id: string;
  description: string | null;
  qty: number;
  order_id: string;
  vendor: string | null;
  order_number: string | null;
  tracking_number: string | null;
  carrier_name: string | null;
  shipment_state: string | null;
  expected_arrival: string | null;
  /** The order ships in parcels and none of them has this line yet. */
  not_shipped: boolean;
}

/** One parcel of an order: its own number, state and day. */
export interface OrderShipment {
  id: string;
  tracking_number: string;
  /** The carrier, by name ("Amazon Logistics"), when the number names one. */
  carrier_name?: string | null;
  shipment_state: string | null;
  shipment_checked_at: string | null;
  expected_arrival: string | null;
  description: string | null;
  created_at: string;
}

/** A tracking number's carrier, identified from the number's own format.
 *  `trackingUrl` is null where the carrier has no single public page to send
 *  someone to (an international postal format shared by many national posts). */
export interface ShipmentCarrier {
  code: string;
  name: string;
  number: string;
  trackingUrl: string | null;
}

/** Where to send someone to look at this parcel. Always present, even when no
 *  carrier was recognised — `isCarrier` says whether it is the carrier's own
 *  page or a universal resolver standing in. */
export interface TrackingLookup {
  url: string;
  via: string;
  isCarrier: boolean;
}

/** Cobblr's own coarse parcel states, not a carrier's codes. */
export type ShipmentState =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"
  | "unknown";

export interface ShipmentStatus {
  carrier: string;
  number: string;
  state: ShipmentState;
  /** The carrier's own wording, always more specific than `state`. */
  description: string;
  location: string | null;
  estimatedDelivery: string | null;
  deliveredAt: string | null;
  events: { at: string; description: string; location: string | null }[];
  checkedAt: string;
}

/** Why there is no status, when there is no status. Each value is a different
 *  thing for the user to do, so none of them may render as silence. */
export type ShipmentStatusReason =
  | "unrecognised"
  | "no_driver"
  | "not_connected"
  | "carrier_error"
  | "quota_exhausted"
  | "busy";

export interface OrderSummary {
  currency?: string;
  money_total?: MoneyTotal;
  count: number;
  open: number;
  in_transit: number;
  from_receipts: number;
  spend: number;
  /** How many orders have a whole total: stated, or from lines that all have a price. */
  priced: number;
  by_month: Array<{ month: string; spend: number }>;
  top_vendors: Array<{ vendor: string | null; spend: number }>;
}

export interface OrderItem {
  currency?: string;
  money_total?: MoneyTotal;
  id: string;
  order_id: string;
  part_id: string | null;
  /** The record this line was claimed for, any kind (a part also sets part_id). */
  subject_kind?: string | null;
  subject_id?: string | null;
  description: string | null;
  qty: string;
  unit_cost: string | null;
  /** How many of its units are in hand, counted one by one (#5734). */
  received_qty?: string | number | null;
  received_at: string | null;
  /** The parcel this line travels in, when the order ships in several. */
  shipment_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** One purchase of one part — a line item flattened with its order's date and
 *  vendor. Mirrors purchases' PricePoint. */
export interface PurchasePricePoint {
  currency?: string;
  original_unit_cost?: number | null;
  id: string;
  order_id: string;
  order_number: string | null;
  vendor: string | null;
  purchased_at: string | null;
  description: string | null;
  qty: number;
  unit_cost: number | null;
}

export interface PurchasePriceStats {
  purchases: number;
  priced: number;
  latest: number | null;
  previous: number | null;
  change_abs: number | null;
  change_pct: number | null;
  direction: "up" | "down" | "flat" | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  first_purchased_at: string | null;
  last_purchased_at: string | null;
  total_spent: number | null;
}

export interface PurchasePriceHistory {
  currency?: string;
  money_total?: MoneyTotal;
  part_id: string | null;
  items: PurchasePricePoint[];
  stats: PurchasePriceStats;
}

/** A line of an order marked arrived whose stock may never have been added. */
export interface UnconfirmedReceiptLine {
  id: string;
  order_id: string;
  vendor: string | null;
  order_number: string | null;
  arrived_at: string | null;
  description: string | null;
  qty: number;
  part_id: string | null;
  part_title: string | null;
  /** Why the stock write refused it (the part is marked gone, or deleted);
   *  null for a line from before receipts added stock reliably. */
  refused: string | null;
}

export const purchasesApi = {

  // purchases module (instance? scopes to /instances/:name/items)
  /** A page of orders, newest first; `next_cursor` fetches the next. Status
   *  and search are applied on the server, over every order. */
  listOrders: (slug: string, instance?: string, opts: { status?: string; q?: string; cursor?: string | null; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.status) p.set("status", opts.status);
    if (opts.q) p.set("q", opts.q);
    if (opts.cursor) p.set("cursor", opts.cursor);
    if (opts.limit) p.set("limit", String(opts.limit));
    const qs = p.toString();
    return request<{ items: Order[]; next_cursor?: string | null }>("GET", `${primaryBase(slug, "purchases/orders", instance)}${qs ? `?${qs}` : ""}`);
  },
  /** The figures over every order the filters match, not the page loaded. */
  orderSummary: (slug: string, opts: { status?: string; q?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.status) p.set("status", opts.status);
    if (opts.q) p.set("q", opts.q);
    const qs = p.toString();
    return request<OrderSummary>("GET", `/orgs/${slug}/modules/purchases/orders/summary${qs ? `?${qs}` : ""}`);
  },
  getOrder: (slug: string, id: string, instance?: string) =>
    request<Order & { items: OrderItem[] }>("GET", `${primaryBase(slug, "purchases/orders", instance)}/${id}`),
  createOrder: (slug: string, body: Partial<Order>, instance?: string) =>
    request<Order>("POST", primaryBase(slug, "purchases/orders", instance), body),
  updateOrder: (slug: string, id: string, body: Partial<Order>, instance?: string) =>
    request<Order>("PATCH", `${primaryBase(slug, "purchases/orders", instance)}/${id}`, body),
  deleteOrder: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "purchases/orders", instance)}/${id}`),
  // Order items are keyed by orderId (their instance rides the parent
  // order), so this stays on the legacy nested route either way.
  addOrderItem: (slug: string, orderId: string, body: Partial<Omit<OrderItem, "qty" | "unit_cost">> & { qty: number; unit_cost?: number | null; add_to_stock?: boolean }) =>
    request<OrderItem>("POST", `/orgs/${slug}/modules/purchases/orders/${orderId}/items`, body),
  /** Correct a line: what it is, how many, the price. A line whose stock was
   *  already added refuses a new count (409 line_received). */
  /** `headers` from editOf: what the edited fields were when the form opened. */
  updateOrderItem: (slug: string, orderId: string, itemId: string, body: { description?: string | null; qty?: number; unit_cost?: number | null; currency?: string }, headers?: Record<string, string>) =>
    request<OrderItem>("PATCH", `/orgs/${slug}/modules/purchases/orders/${orderId}/items/${itemId}`, body, headers),
  listOrderReturns: (slug: string, orderId: string) =>
    request<{ items: OrderReturn[] }>("GET", `/orgs/${slug}/modules/purchases/orders/${orderId}/returns`),
  /** Start a return on one line: how many and why. */
  startOrderReturn: (slug: string, orderId: string, body: { line_id: string; qty: number; reason?: string | null }) =>
    request<{ return: OrderReturn | null; created: boolean }>("POST", `/orgs/${slug}/modules/purchases/orders/${orderId}/returns`, { ...body, stage: "requested" }),
  /** Move a return to a stage; a refund carries its amount. */
  advanceOrderReturn: (slug: string, returnId: string, body: { stage: ReturnStage; refund_amount?: number | null }) =>
    request<{ return: OrderReturn | null; moved: boolean }>("POST", `/orgs/${slug}/modules/purchases/returns/${returnId}/stage`, body),
  removeOrderItem: (slug: string, orderId: string, itemId: string) =>
    request<{ deleted: string; items_remaining: number }>("DELETE", `/orgs/${slug}/modules/purchases/orders/${orderId}/items/${itemId}`),

  listVendors: (slug: string) =>
    request<{ items: VendorSummary[] }>("GET", `/orgs/${slug}/modules/purchases/vendors`),
  getVendor: (slug: string, id: string) =>
    request<VendorDetail>("GET", `/orgs/${slug}/modules/purchases/vendors/${id}`),
  createVendor: (slug: string, body: Partial<Vendor>) =>
    request<Vendor>("POST", `/orgs/${slug}/modules/purchases/vendors`, body),
  updateVendor: (slug: string, id: string, body: Partial<Vendor>) =>
    request<Vendor>("PATCH", `/orgs/${slug}/modules/purchases/vendors/${id}`, body),
  deleteVendor: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/purchases/vendors/${id}`),
  /** A part's purchase history + price stats, from purchases' own full-fat
   *  /items route (the generic entities list can't carry unit_cost — costs
   *  aren't in the kind's exposableFields). Empty items = never bought. */
  /** A parcel of an order: a number or a pasted tracking link, and the lines
   *  in it (none: purchases decides from the whole order). */
  addShipment: (slug: string, orderId: string, body: { tracking_number: string; line_ids?: string[] }) =>
    request<ShipmentOutcome>("POST", `/orgs/${slug}/modules/purchases/orders/${orderId}/shipments`, body),
  /** What is still on its way for one record, or for one order line. */
  purchasesIncoming: (slug: string, q: { kind: string; id: string } | { line_id: string }) =>
    request<{ items: IncomingLine[] }>(
      "GET",
      `/orgs/${slug}/modules/purchases/incoming?${new URLSearchParams(q as Record<string, string>).toString()}`,
    ),
  purchasesPriceHistory: (slug: string, partId: string) =>
    request<PurchasePriceHistory>(
      "GET",
      `/orgs/${slug}/modules/purchases/items?part_id=${encodeURIComponent(partId)}`,
    ),
  /** Which carrier a tracking number belongs to, worked out from the number's
   *  own format + check digit. `carrier: null` means no format recognised it,
   *  which is a normal answer about a real parcel rather than an error. */
  shipmentCarrier: (slug: string, number: string) =>
    request<{ carrier: ShipmentCarrier | null; lookup: TrackingLookup }>(
      "GET",
      `/orgs/${slug}/modules/core-shipments/carrier?number=${encodeURIComponent(number)}`,
    ),
  /** Where the parcel is, asked of the carrier now. A null `status` always
   *  comes with a `reason`, because "we could not follow it" and "it has not
   *  moved" are different answers and must not both render as blank. */
  shipmentStatus: (slug: string, number: string) =>
    request<{
      carrier: ShipmentCarrier | null;
      status: ShipmentStatus | null;
      reason: ShipmentStatusReason | null;
    }>("GET", `/orgs/${slug}/modules/core-shipments/status?number=${encodeURIComponent(number)}`),
  // ── Pools: a Cobblr-native set of devices to queue jobs onto (auto-assigned). ──
  // Lines of orders marked arrived whose stock may never have been added.
  listUnconfirmedReceipts: (slug: string) =>
    request<{ items: UnconfirmedReceiptLine[] }>("GET", `/orgs/${slug}/modules/purchases/unconfirmed-receipts`),
  settleUnconfirmedReceipt: (slug: string, id: string, decision: "add" | "counted") =>
    request<{ settled: boolean }>("POST", `/orgs/${slug}/modules/purchases/unconfirmed-receipts/${id}`, { decision }),
  // Collapse a receipt's pending lines into ONE purchases order (vendor + line
  // items) instead of N orphan parts. Each line is still confirmed into a part;
  // the order links them. Degrades to parts-only if purchases isn't enabled.
  /** "Which order did THIS receipt become?" — asked by the scan card's
   *  contributed panel, which knows only its own receipt group id. Returns the
   *  order with its lines, or null when purchases never saw it (module off, or
   *  a receipt parsed before orders were created at parse time). */
  findPurchaseOrderByReceiptGroup: async (slug: string, groupId: string) => {
    const r = await request<{
      items: Array<{ id: string; item_count?: number | string }>;
    }>("GET", `/orgs/${slug}/modules/purchases/orders?receipt_group_id=${encodeURIComponent(groupId)}`);
    const hit = r.items?.[0];
    if (!hit) return null;
    return request<{
      id: string;
      items?: Array<{ id: string; description: string | null; qty: number; unit_cost: number | null; part_id: string | null }>;
    }>("GET", `/orgs/${slug}/modules/purchases/orders/${hit.id}`);
  },
};
