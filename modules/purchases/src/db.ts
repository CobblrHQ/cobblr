// Tenant-side DB types for purchases. Kysely-friendly.

import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { requestInstance } from "@cobblr/platform-contract/request-instance";

export type OrderStatus = "planned" | "ordered" | "in-transit" | "arrived" | "cancelled";

export interface PurchasesVendorsTable {
  id: Generated<string>;
  name: string;
  website: string | null;
  account_number: string | null;
  contact: string | null;
  lead_time_days: number | null;
  notes: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PurchasesOrdersTable {
  id: Generated<string>;
  vendor: string | null;
  vendor_id: string | null;
  order_number: string | null;
  url: string | null;
  ordered_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  expected_arrival: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  arrived_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  status: OrderStatus;
  total_cost: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  shipping_cost: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  tracking_number: string | null;
  tracking_added_by_user_id: string | null;
  add_to_stock: ColumnType<boolean, boolean | undefined, boolean | undefined>;
  notes: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PurchasesOrderItemsTable {
  id: Generated<string>;
  order_id: string;
  part_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  description: string | null;
  qty: ColumnType<string, number, number>;
  unit_cost: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  /** What the SOURCE line stated, when it stated an amount rather than a
   *  per-unit price. unit_cost may be derived (amount / qty) and therefore
   *  may not multiply back exactly; this does not. */
  line_amount: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  consumed_by_module: string | null;
  consumed_by_entity_type: string | null;
  consumed_by_entity_id: string | null;
  received_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  /** Received before a line's stock was reliably added; a person settles it
   *  (0010, heal-unreceived-arrivals.ts). */
  receipt_unconfirmed: Generated<boolean>;
  /** The parcel this line travels in, when the order shipped in more than
   *  one (0012). Null: it travels under the order's own tracking number. */
  shipment_id: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** Its receive was taken back because a shipping notice showed it was not
   *  in hand (0012); its next receive adds stock but no cost. */
  stock_withdrawn_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type ReturnStage = "requested" | "dropped_off" | "received" | "refunded" | "cancelled";

export interface PurchasesReturnsTable {
  id: Generated<string>;
  order_id: string;
  line_id: string | null;
  item: string | null;
  qty: ColumnType<string, number | undefined, number | undefined>;
  reason: string | null;
  stage: ReturnStage;
  refund_amount: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  refunded_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  stock_returned_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  moved_in: Generated<boolean>;
  /** A jsonb array: written as a JSON string (lint:jsonb-array-writes). */
  steps: ColumnType<unknown[], string | undefined, string>;
  created_by: string | null;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** One parcel of an order (0012). */
export interface PurchasesOrderShipmentsTable {
  id: Generated<string>;
  order_id: string;
  tracking_number: string;
  shipment_state: string | null;
  shipment_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>;
  shipment_next_poll_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>;
  expected_arrival: ColumnType<Date | string | null, string | null | undefined, string | null | undefined>;
  eta_source: string | null;
  description: string | null;
  asked_state: string | null;
  tracking_added_by_user_id: string | null;
  received_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PurchasesDB {
  purchases_vendors: PurchasesVendorsTable;
  purchases_order_shipments: PurchasesOrderShipmentsTable;
  purchases_returns: PurchasesReturnsTable;
  purchases_orders: PurchasesOrdersTable;
  purchases_order_items: PurchasesOrderItemsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<PurchasesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("purchases route called without tenant context");
  return t.db as Kysely<PurchasesDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("purchases route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("purchases route called without session");
  return s;
}

/** Instance scope for the request — set by resolveInstance on
 *  /instances/:name/items; falls back to "purchases" (the DB column
 *  default) on legacy routes. */
export function instanceOf(req: Request): string {
  return requestInstance(req, "purchases");
}
