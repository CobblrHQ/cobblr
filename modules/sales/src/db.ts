// Tenant-side DB types for sales. Kysely-friendly. Numeric columns come back
// from pg as strings; coerce when doing math.

import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";

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
  order_date: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  fulfilled_at: ColumnType<Date | null, string | null | undefined, string | null | undefined>;
  shipping_address: string | null;
  notes: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SalesOrderItemsTable {
  id: Generated<string>;
  order_id: string;
  part_id: string | null;
  description: string | null;
  qty: ColumnType<string, number, number>;
  unit_price: ColumnType<string | null, number | null | undefined, number | null | undefined>;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SalesDB {
  sales_customers: SalesCustomersTable;
  sales_orders: SalesOrdersTable;
  sales_order_items: SalesOrderItemsTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

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
  return (req as unknown as { instance?: string }).instance ?? "sales";
}
