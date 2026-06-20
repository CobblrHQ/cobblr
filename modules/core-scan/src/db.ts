// Tenant-side DB types for core-scan.

import type { Generated, Kysely } from "kysely";
import type { Request } from "express";

export type ScanStatus = "pending" | "enriching" | "resolved" | "discarded";
export type ScanSourceKind = "barcode" | "photo" | "url" | "receipt" | "note";

export interface CoreScanInboxItemsTable {
  id: Generated<string>;
  status: Generated<ScanStatus>;
  source_kind: ScanSourceKind;
  barcode_text: string | null;
  source_url: string | null;
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  catalog_image_url: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  suggested_metadata: Generated<Record<string, unknown>>;
  /** Ranked matchmaker routing candidates (services/matchmaker.ts). */
  suggested_candidates: Generated<unknown[]>;
  ai_notes: string | null;
  ai_confidence: string | null;
  ai_suggested_at: Date | null;
  target_module: string | null;
  target_kind: string | null;
  target_entity_id: string | null;
  target_location_id: string | null;
  scan_batch_id: string | null;
  scan_area: string | null;
  quantity: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  resolved_at: Date | null;
}

export interface CoreScanBatchesTable {
  id: Generated<string>;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
}

export interface CoreScanBarcodeCacheTable {
  upc: string;
  found: boolean;
  source: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: Generated<Record<string, unknown>>;
  fetched_at: Generated<Date>;
}

/** Captured eval cases — P2 of the matchmaker eval harness. A platform admin's
 *  corrected scan commit, recorded as a golden case (input + menu + expected). */
export interface CoreScanEvalCasesTable {
  id: Generated<string>;
  inbox_item_id: string | null;
  surface: Generated<string>;
  perceived_input: Record<string, unknown>;
  scan_menu: Generated<unknown[]>;
  candidates: Generated<unknown[]>;
  expected: Record<string, unknown>;
  note: string | null;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
}

/** External QR resolver rules — the per-workspace redirect table. A scanned
 *  foreign QR payload is matched against these (ordered by position); the first
 *  match extracts a key + resolves it to a Cobblr entity. See
 *  services/qr-resolver.ts + docs/design-decisions/external-qr-resolver.md. */
export interface CoreScanQrRulesTable {
  id: Generated<string>;
  name: string;
  enabled: Generated<boolean>;
  position: Generated<number>;
  /** { type: 'url_prefix'|'regex'|'bare', value?: string } */
  match_spec: Record<string, unknown>;
  /** { source?, group?, type_from?, transform?: string[] } */
  extract_spec: Generated<Record<string, unknown>>;
  /** { target_kind?, type_map?, key_field } */
  resolve_spec: Record<string, unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CoreScanDB {
  core_scan_inbox_items: CoreScanInboxItemsTable;
  core_scan_batches: CoreScanBatchesTable;
  core_scan_barcode_cache: CoreScanBarcodeCacheTable;
  core_scan_eval_cases: CoreScanEvalCasesTable;
  core_scan_qr_rules: CoreScanQrRulesTable;
}

export type OrgRole = "owner" | "admin" | "member" | "guest";

interface RequestWithTenant {
  tenant?: {
    org: { id: string; name: string; slug: string };
    role: OrgRole;
    db: unknown;
  };
  session?: { id: string; email: string; display_name: string; is_platform_admin?: boolean };
}

export function tenantDb(req: Request): Kysely<CoreScanDB> {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-scan called without tenant context");
  return t.db as Kysely<CoreScanDB>;
}

export function tenantContext(req: Request) {
  const t = (req as unknown as RequestWithTenant).tenant;
  if (!t) throw new Error("core-scan called without tenant context");
  return { org: t.org, role: t.role };
}

export function sessionUser(req: Request) {
  const s = (req as unknown as RequestWithTenant).session;
  if (!s) throw new Error("core-scan called without session");
  return s;
}

export function bearer(req: Request): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return null;
}
