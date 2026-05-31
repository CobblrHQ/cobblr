// Kysely table types for core-apps. Mirrors migrations/0001_init.sql.
// Same boundary-casting pattern as sibling modules (core-views).

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface AppsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  icon: string | null;
  /** Capability a member must hold to see this app in their portal
   *  nav. Null = any member of the workspace. owner/admin implicitly
   *  hold everything. */
  visible_capability: string | null;
  /** Ordered pages → ordered blocks. Validated by the AppDefinition
   *  zod schema in api/apps.ts; opaque jsonb at the DB layer. */
  pages: Generated<unknown>;
  /** Optional per-app theme tokens (palette/font/radius) the App Player
   *  applies as CSS variables. Validated by the Theme zod schema in
   *  api/apps.ts; null = Cobblr defaults. */
  theme: unknown | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreAppsDB {
  core_apps_apps: AppsTable;
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

export function tenantDb(req: Request): Kysely<CoreAppsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-apps route called without tenant context");
  return t.db as Kysely<CoreAppsDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-apps route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
