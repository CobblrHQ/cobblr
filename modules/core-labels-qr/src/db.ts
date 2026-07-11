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
  // A stable base URL the workspace controls + forwards to this instance, so
  // printed codes survive a move. null/empty = encode against the serving
  // origin. See migration 0003.
  label_base_url: string | null;
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

/** Read the workspace's custom QR label base URL (trimmed, no trailing slash),
 *  or null if unset — in which case callers fall back to the serving origin. */
export async function getQrLabelBaseUrl(db: Kysely<CoreLabelsQrDB>): Promise<string | null> {
  const row = await db
    .selectFrom("core_labels_qr_settings")
    .select("label_base_url")
    .where("id", "=", 1)
    .executeTakeFirst();
  const v = row?.label_base_url?.trim();
  return v ? v.replace(/\/+$/, "") : null;
}

/** Build the full scan URL a printed/displayed QR encodes: `<base>/qr/<token>`.
 *  The `/qr/<token>` path is the stable contract a custom base must forward to. */
export function qrScanUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/qr/${token}`;
}

/** A readable, deterministic token for the descriptive style:
 *  "<kind-local-name>/<entity-id>", e.g. "location/9a8e…". The full kind
 *  still lives on the token row, so this is purely the human-readable label
 *  (and stays unique because the entity id is a UUID).
 *  Superseded by qrShortcode + a short slug for new descriptive tokens; kept for
 *  reference and for resolving already-printed labels. */
export function descriptiveToken(entityKind: string, entityId: string): string {
  const alias = entityKind.split(":").pop() || entityKind;
  return `${alias}/${entityId}`;
}

// A short, curated code per kind so a descriptive token reads short
// ("loc/<slug>" not "location/<slug>"). Instance-specific codes (a "3D Printers"
// machines instance → "3dp") are a later registry; this keys on the kind.
const KIND_SHORTCODES: Record<string, string> = {
  location: "loc",
  part: "inv", // inventory items
  asset: "ast",
  machine: "mch",
  project: "prj",
  task: "tsk",
  list: "lst",
};

/** 3-char shortcode for a descriptive token's readable half. Built-in kinds get
 *  a curated code; anything else falls back to the first url-safe chars of its
 *  local name. Never empty. */
export function qrShortcode(entityKind: string): string {
  const alias = (entityKind.split(":").pop() || entityKind).toLowerCase();
  return KIND_SHORTCODES[alias] ?? (alias.replace(/[^a-z0-9]/g, "").slice(0, 3) || "obj");
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
