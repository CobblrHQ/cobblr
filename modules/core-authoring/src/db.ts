// Kysely table types for core-authoring. Mirrors migrations/0001_init.sql.
// Same boundary-casting pattern as sibling modules (core-apps).

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface DraftsTable {
  id: Generated<string>;
  task: Generated<string>;
  intent: string;
  selected_kinds: Generated<unknown>;
  context_snapshot: unknown | null;
  compiled_prompt: string;
  mode: Generated<string>;
  model: string | null;
  candidate: unknown | null;
  validation: unknown | null;
  interpretation: string | null;
  seed_plan: unknown | null;
  base_template_id: string | null;
  repair_attempts: Generated<number>;
  status: Generated<string>;
  parent_draft_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreAuthoringDB {
  core_authoring_drafts: DraftsTable;
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

export function tenantDb(req: Request): Kysely<CoreAuthoringDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-authoring route called without tenant context");
  return t.db as Kysely<CoreAuthoringDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-authoring route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
