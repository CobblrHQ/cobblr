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
  assigned_to: string | null;
  // Assorted contents (migration 0008). approximate_qty's PRESENCE is what
  // marks a record as an estimate rather than a count.
  approximate_qty: string | null;
  estimated_at: Date | null;
  warranty_expires: Date | null;
  lifetime_warranty: Generated<boolean>;
  warranty_details: string | null;
  insured: Generated<boolean>;
  archived: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** Columns the parts list resolver filters NATIVELY (`where col = value`).
 *
 *  Everything not listed here is treated as a metadata key and compiled to
 *  `metadata ->> key = value` (the D8 dialect). That fallback is right for a
 *  custom field and silently WRONG for a real column: `metadata ->> 'x'` is null
 *  for every row when `x` lives in its own column, so the filter matches nothing
 *  and reports it as "no such entity" rather than as an error.
 *
 *  That shipped: this set held only category_id/location_id/state, so a scan rule
 *  resolving on `serial_number` (a real column since migration 0004) could never
 *  match a part. Hence the rule: this set is EVERY column except `metadata`
 *  itself, and `lint:part-filter-cols` fails the build if a column is added to
 *  the table without landing here.
 */
export const PART_FILTER_COLS = new Set([
  "id",
  "name",
  "description",
  "category_id",
  "location_id",
  "qty",
  "unit",
  "cost",
  "min_qty",
  "manufacturer",
  "supplier_url",
  "image_path",
  "notes",
  "state",
  "instance",
  "asset_id",
  "serial_number",
  "model_number",
  "assigned_to",
  "approximate_qty",
  "estimated_at",
  "warranty_expires",
  "lifetime_warranty",
  "warranty_details",
  "insured",
  "archived",
  "created_at",
  "updated_at",
]);

/** Native columns compared case-INSENSITIVELY (`lower(col) = lower(value)`).
 *
 *  These carry identifiers that get physically marked on an object and read back
 *  by a machine: a scanner reports whatever the keyboard layout gives it, so the
 *  same lasered mark can arrive as "wx-42" or "WX-42". Exact equality makes a
 *  part resolvable or not depending on which scanner read it.
 *
 *  Migration 0004 already indexes `lower(serial_number)`, which an `=` comparison
 *  cannot use anyway — so this also makes that index live. */
export const PART_CI_FILTER_COLS = new Set(["serial_number", "model_number", "assigned_to"]);

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

/** Append-only consumption ledger — one row per stock change with a source, so
 *  a consumable shows WHAT drew it down and HOW MUCH (the spool's print history).
 *  delta is signed: negative = consumed, positive = restocked. */
export interface InventoryConsumptionTable {
  id: Generated<string>;
  part_id: string;
  delta: string;
  reason: string | null;
  source_kind: string | null;
  source_id: string | null;
  at: Generated<Date>;
}

export interface InventoryDB {
  inventory_categories: InventoryCategoriesTable;
  inventory_parts: InventoryPartsTable;
  inventory_allocations: InventoryAllocationsTable;
  inventory_consumption: InventoryConsumptionTable;
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

/** The instance's default quantity unit (a "yarn" instance tracks skeins),
 *  from the config blob resolveInstance stamps on the request. Null on
 *  legacy /modules routes or when the instance sets none — callers fall
 *  back to "each". */
export function instanceQtyUnit(req: Request): string | null {
  const cfg = (req as unknown as { instanceConfig?: Record<string, unknown> }).instanceConfig;
  const unit = cfg?.qty_unit;
  return typeof unit === "string" && unit.trim() ? unit : null;
}
