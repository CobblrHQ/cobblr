import type { Generated, ColumnType, Kysely } from "kysely";
import type { Request } from "express";

type ColJsonb = ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown> | undefined>;

export interface RecordsRecordsTable {
  id: Generated<string>;
  name: string;
  image_path: string | null;
  notes: string | null;
  location_id: string | null;
  metadata: ColJsonb;
  /** Multi-instance scope. Defaults to 'records' at the DB level so
   *  legacy code paths keep working; instance-aware writes set it. */
  instance: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RecordsDB {
  records_records: RecordsRecordsTable;
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

export function tenantDb(req: Request): Kysely<RecordsDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("records route called without tenant context");
  return t.db as Kysely<RecordsDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("records route called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("records route called without session");
  return s;
}

/** The instance this request is scoped to. Set by the platform's
 *  resolveInstance middleware on /instances/:name/items routes; absent
 *  on legacy /modules/records/records requests, where it falls back to
 *  "records" — matching the DB column default. Every record query filters
 *  on this; every insert stamps it. */
export function instanceOf(req: Request): string {
  return (req as unknown as { instance?: string }).instance ?? "records";
}
