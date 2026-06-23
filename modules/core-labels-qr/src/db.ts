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

// Singleton per-workspace settings (one row, id=1).
export interface CoreLabelsQrSettingsTable {
  id: Generated<number>;
  token_style: Generated<"descriptive" | "opaque">;
  updated_at: Generated<Date>;
}

export interface CoreLabelsQrDB {
  core_labels_qr_scans: CoreLabelsQrScansTable;
  core_labels_qr_settings: CoreLabelsQrSettingsTable;
}

export type QrTokenStyle = "descriptive" | "opaque";

/** Read the workspace's QR token style (default descriptive). */
export async function getQrTokenStyle(db: Kysely<CoreLabelsQrDB>): Promise<QrTokenStyle> {
  const row = await db
    .selectFrom("core_labels_qr_settings")
    .select("token_style")
    .where("id", "=", 1)
    .executeTakeFirst();
  return row?.token_style ?? "descriptive";
}

/** A readable, deterministic token for the descriptive style:
 *  "<kind-local-name>/<entity-id>", e.g. "location/9a8e…". The full kind
 *  still lives on the token row, so this is purely the human-readable label
 *  (and stays unique because the entity id is a UUID). */
export function descriptiveToken(entityKind: string, entityId: string): string {
  const alias = entityKind.split(":").pop() || entityKind;
  return `${alias}/${entityId}`;
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
