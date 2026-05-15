import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";

type ColJsonb = ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;

export interface MachinesMachinesTable {
  id: Generated<string>;
  name: string;
  short_name: string | null;
  family: string | null;
  type: string | null;
  manufacturer: string | null;
  state: Generated<string>;
  excitement: Generated<number>;
  image_path: string | null;
  notes: string | null;
  quantity: Generated<number>;
  location_id: string | null;
  metadata: ColJsonb;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MachinesDB {
  machines_machines: MachinesMachinesTable;
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
