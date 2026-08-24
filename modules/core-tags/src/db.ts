// Kysely table types for core-tags. Mirrors migrations/0001_init.sql.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface TagsTable {
  id: Generated<string>;
  name: string;
  color: string | null;
  parent_id: string | null;
  icon: string | null;
  /** Keeps a tag at the front of every chip row and exempts it from the
   *  relevance collapse (see src/relevance.ts). */
  pinned: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TagAssignmentsTable {
  id: Generated<string>;
  tag_id: string;
  source_module: string;
  source_type: string;
  source_id: string;
  created_at: Generated<Date>;
}

export interface CoreTagsDB {
  core_tags_tags: TagsTable;
  core_tags_assignments: TagAssignmentsTable;
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

export function tenantDb(req: Request): Kysely<CoreTagsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-tags route called without tenant context");
  return t.db as Kysely<CoreTagsDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-tags route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
