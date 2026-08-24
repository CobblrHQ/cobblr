// Tenant-side DB types for core-units. Mirrors migrations/0001_init.sql.
//
// Two tables, both per-tenant (the tenant DB is already one-per-org, so a
// single settings row is fine):
//   core_units_custom   — units a workspace adds beyond the built-ins
//   core_units_settings — the workspace's display mode (one row)

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface CustomUnitsTable {
  code: string; // primary key — canonical identity within the workspace
  symbol: string;
  name: string;
  plural: string;
  category: string;
  created_at: Generated<Date>;
}

export interface UnitsSettingsTable {
  id: Generated<number>; // always 1 — single-row table
  display_mode: Generated<"symbol" | "name" | "both">;
  updated_at: Generated<Date>;
}

export interface CoreUnitsDB {
  core_units_custom: CustomUnitsTable;
  core_units_settings: UnitsSettingsTable;
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

export function tenantDb(req: Request): Kysely<CoreUnitsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-units called without tenant context");
  return t.db as Kysely<CoreUnitsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-units called without tenant context");
  return { org: t.org, role: t.role };
}
