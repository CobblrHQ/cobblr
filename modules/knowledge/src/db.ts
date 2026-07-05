// Kysely table types for knowledge. Column names match the migration
// (snake_case, no @map). Same tenant-context helpers as sibling modules.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface EntriesTable {
  id: Generated<string>;
  title: string;
  body: string | null;
  kind: string | null;
  pinned: Generated<boolean>;
  code: string | null;
  image_path: string | null;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface KnowledgeDB {
  knowledge_entries: EntriesTable;
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

export function tenantDb(req: Request): Kysely<KnowledgeDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("knowledge route called without tenant context");
  return t.db as Kysely<KnowledgeDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("knowledge route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
