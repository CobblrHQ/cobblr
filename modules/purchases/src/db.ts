// Tenant-side DB types for purchases. Kysely-friendly.

import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

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
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PurchasesDB {
  purchases_vendors: PurchasesVendorsTable;
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
  return (req as unknown as { instance?: string }).instance ?? "purchases";
}
