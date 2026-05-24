// Tenant-side DB types — just the scan audit log; the token rows
// live cross-tenant in cobblr_meta.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CoreLabelsQrScansTable {
  id: Generated<string>;
  token_id: string;
  scanned_at: Generated<Date>;
  ua_hint: string | null;
  referer: string | null;
  action_invoked: string | null;
  action_ok: boolean | null;
}

export interface CoreLabelsQrDB {
  core_labels_qr_scans: CoreLabelsQrScansTable;
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

export function tenantDb(req: Request): Kysely<CoreLabelsQrDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-labels-qr route called without tenant context");
  return t.db as Kysely<CoreLabelsQrDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-labels-qr route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(
  req: Request,
): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
