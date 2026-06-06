// Tenant-side DB types + request helpers for core-print.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CorePrintPrintersTable {
  id: Generated<string>;
  name: string;
  driver: string;
  base_url: string;
  queue: string;
  credentials_enc: string | null;
  is_default: Generated<boolean>;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CorePrintDB {
  core_print_printers: CorePrintPrintersTable;
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

export function tenantDb(req: Request): Kysely<CorePrintDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-print called without tenant context");
  return t.db as Kysely<CorePrintDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-print called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("core-print called without session");
  return s;
}
