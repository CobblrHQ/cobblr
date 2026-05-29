// Kysely table types for the inventory module's tenant-side
// tables. Mirrors migrations/0001_init.sql.
//
// The platform's withTenant middleware sets req.tenant on the
// request before our handlers run. Rather than play TypeScript
// module-augmentation games (the api workspace has its own
// augmentation; merging conflicts), we read tenant via the
// helpers below — they cast at the boundary so handlers stay
// type-safe.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface InventoryCategoriesTable {
  id: Generated<string>;
  name: string;
  slug: string;
  color: string | null;
  parent_id: string | null;
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type PartState = "active" | "draft" | "needs_review";

export interface InventoryPartsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  category_id: string | null;
  location_id: string | null;
  // Numeric columns come back from pg as strings by default — we
  // coerce when we need arithmetic; otherwise pass through as-is.
  qty: Generated<string>;
  unit: Generated<string>;
  cost: string | null;
  min_qty: string | null;
  manufacturer: string | null;
  supplier_url: string | null;
  image_path: string | null;
  notes: string | null;
  state: Generated<PartState>;
  metadata: Generated<Record<string, unknown>>;
  instance: Generated<string>;
  // HomeBox parity fields (migration 0004).
  asset_id: Generated<number>;
  serial_number: string | null;
  model_number: string | null;
  warranty_expires: Date | null;
  lifetime_warranty: Generated<boolean>;
  warranty_details: string | null;
  insured: Generated<boolean>;
  archived: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type AllocationStatus = "reserved" | "consumed" | "released";

export interface InventoryAllocationsTable {
  id: Generated<string>;
  part_id: string;
  qty: string;
  status: Generated<AllocationStatus>;
  target_module: string;
  target_entity_type: string;
  target_entity_id: string;
  reason: string | null;
  reserved_at: Generated<Date>;
  consumed_at: Date | null;
  released_at: Date | null;
  instance: Generated<string>;
}

export interface InventoryDB {
  inventory_categories: InventoryCategoriesTable;
  inventory_parts: InventoryPartsTable;
  inventory_allocations: InventoryAllocationsTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<InventoryDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("inventory route called without tenant context");
  return t.db as Kysely<InventoryDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("inventory route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request): { id: string; email: string; display_name: string } {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("inventory route called without session");
  return s;
}

/** The instance this request is scoped to. Set by the platform's
 *  resolveInstance middleware on /instances/:name/items routes; absent
 *  on legacy /modules/inventory/parts requests, where it falls back to
 *  "inventory" — matching the DB column default, so legacy rows and the
 *  default instance line up with zero behaviour change. Every parts
 *  query filters on this; every insert stamps it. */
export function instanceOf(req: Request): string {
  return (req as unknown as { instance?: string }).instance ?? "inventory";
}
