// Kysely table types for core-views. Mirrors
// migrations/0001_init.sql. Same boundary-casting pattern as
// sibling modules.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface ViewsTable {
  id: Generated<string>;
  entity_kind: string;
  name: string;
  view_type: string;
  config: Generated<Record<string, unknown>>;
  is_default: Generated<boolean>;
  /** v0.3: explicit pin flag so the dashboard can render the views
   *  the user actually wants pinned instead of the first 2 shared. */
  pinned: Generated<boolean>;
  owner_user_id: string | null;
  /** v1.5: bundle that shipped this view, if any. Cleared on bundle
   *  uninstall (manual cascade — bundles table lives cross-DB). */
  bundle_id: string | null;
  /** v1.5: module whose `contributes.savedViews` shipped this view,
   *  if any. Cleared on module disable. */
  source_module: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreViewsDB {
  core_views_views: ViewsTable;
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

export function tenantDb(req: Request): Kysely<CoreViewsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-views route called without tenant context");
  return t.db as Kysely<CoreViewsDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-views route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
