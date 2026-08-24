// Tenant-side DB types for the QR half of labels (merged in from the former
// core-labels-qr module) — the scan audit log + the per-workspace settings
// singleton. The token rows live cross-tenant in cobblr_meta (the table keeps
// its historical `core_labels_qr_tokens` name there: printed URLs and the
// immutable platform migration both outlive module identity).

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";
import type { OrgRoleName } from "@cobblr/platform-contract/org-roles";

export interface LabelsQrScansTable {
  id: Generated<string>;
  token_id: string;
  scanned_at: Generated<Date>;
  ua_hint: string | null;
  referer: string | null;
  action_invoked: string | null;
  action_ok: boolean | null;
}

// Singleton per-workspace settings (one row, id=1).
export interface LabelsQrSettingsTable {
  id: Generated<number>;
  token_style: Generated<"descriptive" | "opaque">;
  // A stable base URL the workspace controls + forwards to this instance, so
  // printed codes survive a move. null/empty = encode against the serving
  // origin. See labels migration 0004 (formerly core-labels-qr 0003).
  label_base_url: string | null;
  updated_at: Generated<Date>;
}

export interface LabelsQrDB {
  labels_qr_scans: LabelsQrScansTable;
  labels_qr_settings: LabelsQrSettingsTable;
}

export type QrTokenStyle = "descriptive" | "opaque";

/** Read the workspace's QR token style (default descriptive). */
export async function getQrTokenStyle(db: Kysely<LabelsQrDB>): Promise<QrTokenStyle> {
  const row = await db
    .selectFrom("labels_qr_settings")
    .select("token_style")
    .where("id", "=", 1)
    .executeTakeFirst();
  return row?.token_style ?? "descriptive";
}

/** Read the workspace's custom QR label base URL (trimmed, no trailing slash),
 *  or null if unset — in which case callers fall back to the serving origin. */
export async function getQrLabelBaseUrl(db: Kysely<LabelsQrDB>): Promise<string | null> {
  const row = await db
    .selectFrom("labels_qr_settings")
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

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRoleName;
    db: unknown;
  };
}

/** The tenant DB typed over the QR tables. Labels' own db.ts types the label
 *  tables; the two views never overlap, so each router imports its own. */
export function qrTenantDb(req: Request): Kysely<LabelsQrDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("labels qr route called without tenant context");
  return t.db as Kysely<LabelsQrDB>;
}
