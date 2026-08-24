import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export type ScopeType = "view" | "entity" | "collection" | "board" | "app";

export interface SurfacesTable {
  id: Generated<string>;
  name: string;
  token: string;
  scope_type: ScopeType;
  scope_id: string;
  config: Generated<Record<string, unknown>>;
  enabled: Generated<boolean>;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** M2 v0.2: per-hit log for surface-viewed analytics. */
export interface SurfaceViewsTable {
  id: Generated<string>;
  surface_id: string;
  viewed_at: Generated<Date>;
  ua_hint: string | null;
  referer: string | null;
}

export interface CorePublicSurfacesDB {
  core_public_surfaces_surfaces: SurfacesTable;
  core_public_surfaces_views: SurfaceViewsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;
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

export function tenantDb(req: Request): Kysely<CorePublicSurfacesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-public-surfaces called without tenant context");
  return t.db as Kysely<CorePublicSurfacesDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-public-surfaces called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
