// Kysely table types for core-locations. Mirrors
// migrations/0001_init.sql.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface LocationsTable {
  id: Generated<string>;
  name: string;
  short_name: string | null;
  parent_id: string | null;
  depth: Generated<number>;
  kind: Generated<"container" | "area">;
  metadata: Generated<Record<string, unknown>>;
  description: string | null;
  notes: string | null;
  image_path: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreLocationsDB {
  core_locations_locations: LocationsTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<CoreLocationsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-locations called without tenant context");
  return t.db as Kysely<CoreLocationsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-locations called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("core-locations called without session");
  return s;
}
