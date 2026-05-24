// Tenant-side DB types for core-maintenance.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export interface CoreMaintenanceEntriesTable {
  id: Generated<string>;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  description: string | null;
  performed_at: Date | null;
  scheduled_at: Date | null;
  cost_cents: number | null;
  performed_by: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreMaintenanceDB {
  core_maintenance_entries: CoreMaintenanceEntriesTable;
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

export function tenantDb(req: Request): Kysely<CoreMaintenanceDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-maintenance route called without tenant context");
  return t.db as Kysely<CoreMaintenanceDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-maintenance route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("core-maintenance route called without session");
  return s;
}
