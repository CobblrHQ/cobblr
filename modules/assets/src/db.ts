import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";

type ColJsonb = ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;
type ColJsonbArr = ColumnType<unknown[], unknown[] | undefined, unknown[] | undefined>;
type ColDate = ColumnType<Date | null, string | null | undefined, string | null | undefined>;

export interface AssetsAssetsTable {
  id: Generated<string>;
  name: string;
  short_name: string | null;
  manufacturer: string | null;
  model: string | null;
  type: string | null;
  state: Generated<string>;
  excitement: Generated<number>;
  quantity: Generated<number>;
  serial_number: string | null;
  purchased_at: ColDate;
  warranty_until: ColDate;
  last_service_at: ColDate;
  image_path: string | null;
  notes: string | null;
  location_id: string | null;
  flags: ColJsonbArr;
  metadata: ColJsonb;
  /** Multi-instance scope. Defaults to 'assets' at the DB level so
   *  legacy code paths keep working; instance-aware writes set it. */
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AssetsDB {
  assets_assets: AssetsAssetsTable;
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

export function tenantDb(req: Request): Kysely<AssetsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("assets route called without tenant context");
  return t.db as Kysely<AssetsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("assets route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("assets route called without session");
  return s;
}
