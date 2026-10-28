// Tenant-side DB types for core-maintenance.

import type { AddressValue } from "@cobblr/platform-contract/address";
import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface CoreMaintenanceEntriesTable {
  is_term: Generated<boolean>;
  term_start: Generated<Date | null>;
  term_end: Generated<Date | null>;
  currency: Generated<string | null>;
  reference: Generated<string | null>;
  quantity: Generated<string | number | null>;
  previous_term_id: Generated<string | null>;
  metadata: Generated<Record<string, unknown>>;
  id: Generated<string>;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  description: string | null;
  performed_at: Date | null;
  counter_reading: Generated<string | number | null>;
  scheduled_at: Date | null;
  cost_cents: number | null;
  performed_by: string | null;
  notes: string | null;
  recurrence_rule: string | null;
  /** Where the visit happens (@cobblr/platform-contract/address), or null. */
  address: Generated<AddressValue | null>;
  last_notified_at: Date | null;
  nag_snoozed_until: Date | null;
  nag_stopped_at: Date | null;
  /** The schedule this entry is an occurrence of, or the one it rolled forward. */
  schedule_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreMaintenanceSchedulesTable {
  renewal_fields: Generated<import("./bound-renewal.js").RenewalFieldBinding | null>;
  cancel_notice_days: Generated<number | null>;
  ended_at: Generated<Date | null>;
  ended_by: Generated<string | null>;
  overdue_every: import("./schedule.js").OverdueCadence | null;
  anchor: import("./schedule.js").RenewalAnchor | null;
  remind: import("./schedule.js").Reminder | null;
  expiry_field: string | null;
  current_expiry: Date | null;
  id: Generated<string>;
  entity_module: string;
  entity_type: string;
  entity_id: string;
  name: string;
  every_n: number | null;
  every_unit: "day" | "week" | "month" | "year" | null;
  counter_field: string | null;
  /** numeric: node-postgres hands it back as a string. */
  counter_every: string | number | null;
  last_done_at: Date | null;
  last_done_counter: string | number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreMaintenanceDB {
  core_maintenance_preferences: { id: boolean; overdue_every: import("./schedule.js").OverdueCadence };
  core_maintenance_entries: CoreMaintenanceEntriesTable;
  core_maintenance_schedules: CoreMaintenanceSchedulesTable;
}

/** Re-exported from the contract so this module cannot fall behind the
 *  vocabulary. It already had: this line used to omit "editor". */
export type OrgRole = OrgRoleName;

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
