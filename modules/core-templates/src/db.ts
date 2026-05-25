// Tenant-side DB types for core-templates.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CoreTemplatesTable {
  id: Generated<string>;
  target_kind: string;
  name: string;
  description: string | null;
  defaults: Generated<Record<string, unknown>>;
  default_tags: Generated<string[]>;
  position: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreTemplatesDB {
  core_templates_templates: CoreTemplatesTable;
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

export function tenantDb(req: Request): Kysely<CoreTemplatesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-templates called without tenant context");
  return t.db as Kysely<CoreTemplatesDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-templates called without tenant context");
  return { org: t.org, role: t.role };
}

export function bearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return null;
}
