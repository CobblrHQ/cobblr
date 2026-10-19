import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";
import { requestInstance } from "@cobblr/platform-contract/request-instance";

type ColJsonb = ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;

export interface MachinesMachinesTable {
  id: Generated<string>;
  name: string;
  short_name: string | null;
  family: string | null;
  type: string | null;
  manufacturer: string | null;
  serial_number: string | null;
  state: Generated<string>;
  excitement: Generated<number>;
  image_path: string | null;
  notes: string | null;
  quantity: Generated<number>;
  location_id: string | null;
  metadata: ColJsonb;
  /** What it runs (0004): each version with where it came from and when it was last seen. */
  firmware_version: string | null;
  firmware_source: VersionSource | null;
  firmware_seen_at: Date | null;
  software_version: string | null;
  software_source: VersionSource | null;
  software_seen_at: Date | null;
  /** The firmware family (Klipper, PrusaLink, RepRapFirmware): half of its cohort. */
  controller: string | null;
  /** Multi-instance scope (defaults to 'machines'). */
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type VersionSource = "reported" | "typed";

/** The version an admin wants one cohort on (0004). */
export interface MachinesVersionTargetsTable {
  id: Generated<string>;
  instance: string;
  cohort: string;
  firmware_target: string | null;
  software_target: string | null;
  set_by: string | null;
  updated_at: Generated<Date>;
}

export interface MachinesDB {
  machines_machines: MachinesMachinesTable;
  machines_version_targets: MachinesVersionTargetsTable;
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

export function tenantDb(req: Request): Kysely<MachinesDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("machines route called without tenant context");
  return t.db as Kysely<MachinesDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("machines route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("machines route called without session");
  return s;
}

/** Instance scope for the request — set by resolveInstance on
 *  /instances/:name/items; falls back to "machines" (the DB column
 *  default) on legacy routes. */
export function instanceOf(req: Request): string {
  return requestInstance(req, "machines");
}
