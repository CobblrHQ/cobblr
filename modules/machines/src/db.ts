import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

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
  /** Multi-instance scope (defaults to 'machines'). */
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MachinesDB {
  machines_machines: MachinesMachinesTable;
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
  return (req as unknown as { instance?: string }).instance ?? "machines";
}
