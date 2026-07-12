// Kysely tenant-DB types for core-catalogs.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CatalogsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  source_url: string | null;
  puller_id: string | null;
  /** Where the ROWS live: "local" (tenant DB, imported) or "hosted" (the shared
   *  reference service). Default "local". See migration 0003 + docs. */
  source: Generated<string>;
  schema: Generated<Record<string, unknown>>;
  last_sync_at: Date | null;
  entry_count: Generated<number>;
  bundle_external_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CatalogEntriesTable {
  id: Generated<string>;
  catalog_id: string;
  external_id: string;
  payload: Generated<Record<string, unknown>>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreCatalogsDB {
  core_catalogs_catalogs: CatalogsTable;
  core_catalogs_entries: CatalogEntriesTable;
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

export function tenantDb(req: Request): Kysely<CoreCatalogsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-catalogs route called without tenant context");
  return t.db as Kysely<CoreCatalogsDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-catalogs route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
