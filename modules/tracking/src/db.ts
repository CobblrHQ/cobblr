// Kysely types for tracking. Columns match the migration (snake_case).
// numeric columns come back as strings from pg; cast at read time.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface MetricsTable {
  id: Generated<string>;
  name: string;
  unit: string | null;
  goal_value: string | null; // numeric
  goal_direction: Generated<string>;
  metadata: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MeasurementsTable {
  id: Generated<string>;
  metric_id: string;
  value: string; // numeric
  measured_at: Generated<Date>;
  note: string | null;
  created_at: Generated<Date>;
}

export interface TrackingDB {
  tracking_metrics: MetricsTable;
  tracking_measurements: MeasurementsTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

export interface TenantContext {
  org: { id: string; name: string; slug: string };
  role: OrgRole;
}

interface RequestWithTenant {
  tenant?: { org: { id: string; name: string; slug: string }; role: OrgRole; db: unknown };
  session?: { id: string; email: string; display_name: string };
}

export function tenantDb(req: Request): Kysely<TrackingDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("tracking route called without tenant context");
  return t.db as Kysely<TrackingDB>;
}

export function tenantContext(req: Request): TenantContext {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("tracking route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request): { id: string; email: string; display_name: string } | null {
  return (req as unknown as RequestWithTenant).session ?? null;
}
