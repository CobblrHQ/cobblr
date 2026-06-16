// Kysely table types for builds. Column names match the migration (snake_case).
// Numeric columns come back from pg as strings; coerce when doing math.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface BuildsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  output_part_id: string | null;
  output_qty: Generated<string>;
  notes: string | null;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ComponentsTable {
  id: Generated<string>;
  build_id: string;
  part_id: string;
  quantity: Generated<string>;
  optional: Generated<boolean>;
  notes: string | null;
  created_at: Generated<Date>;
}

export interface RunsTable {
  id: Generated<string>;
  build_id: string;
  qty_built: Generated<string>;
  consumed: Generated<unknown>;
  built_by: string | null;
  built_at: Generated<Date>;
}

export interface BuildsDB {
  builds_builds: BuildsTable;
  builds_components: ComponentsTable;
  builds_runs: RunsTable;
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

export function tenantDb(req: Request): Kysely<BuildsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("builds route called without tenant context");
  return t.db as Kysely<BuildsDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("builds route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
