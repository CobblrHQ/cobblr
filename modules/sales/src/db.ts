// Tenant-side DB types for sales. Kysely-friendly. Numeric columns come back
// from pg as strings; coerce when doing math.

import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { requestInstance } from "@cobblr/platform-contract/request-instance";

export type SalesOrderStatus =
  | "draft"
  | "confirmed"
  | "fulfilled"
  | "shipped"
  | "closed"
  | "cancelled";

export interface SalesCustomersTable {
  id: Generated<string>;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SalesOrdersTable {
  id: Generated<string>;
  customer_id: string | null;
  customer_name: string | null;
  order_number: string | null;
  status: SalesOrderStatus;
  paid: Generated<boolean>;
  auto_closed_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  auto_close_undone: Generated<boolean>;
  order_date: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  fulfilled_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  carrier: string | null;
  tracking_number: string | null;
  shipped_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null | undefined>;
  shipping_address: string | null;
  source_name: string | null;
  source_ref: string | null;
  source_url: string | null;
  notes: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  /** Where a sent parcel is, as core-shipments last said, for "Follow parcels
   *  I send". Null until the sweep first asks. */
  shipment_state: string | null;
  shipment_checked_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  shipment_next_poll_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  delivered_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SalesSettingsTable {
  key: string;
  value: ColumnType<Record<string, unknown>, string, string>;
  updated_at: Generated<Date>;
}

export interface SalesOrderItemsTable {
  id: Generated<string>;
  order_id: string;
  part_id: string | null;
  description: string | null;
  qty: ColumnType<string, number, number>;
  /** How many of this line have left stock so far; the rest is still owed. */
  qty_fulfilled: ColumnType<string, string | undefined, string | undefined>;
  unit_price: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type SalesHistoryKind = "status" | "stock" | "shipped" | "email" | "work_order" | "line" | "delivered";

export interface SalesOrderHistoryTable {
  id: Generated<string>;
  order_id: string;
  kind: SalesHistoryKind;
  from_status: string | null;
  to_status: string | null;
  detail: ColumnType<Record<string, unknown>, string | undefined, string | undefined>;
  by_user: string | null;
  created_at: Generated<Date>;
}

export interface SalesDB {
  sales_customers: SalesCustomersTable;
  sales_orders: SalesOrdersTable;
  sales_order_items: SalesOrderItemsTable;
  sales_order_history: SalesOrderHistoryTable;
  sales_settings: SalesSettingsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: { org: { id: string; name: string; slug: string }; role: OrgRole; db: unknown };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<SalesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("sales route called without tenant context");
  return t.db as Kysely<SalesDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("sales route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}

/** Instance scope for the request; falls back to the "sales" default column. */
export function instanceOf(req: Request): string {
  return requestInstance(req, "sales");
}
