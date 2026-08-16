// Tenant-side DB types for core-scan.

import type { ColumnType, Generated, Kysely } from "kysely";
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
  /** Scan-into-container: the active bin can be any container (a server asset, a
   *  machine), not only a location. When set, confirm places the created entity
   *  INSIDE it (a placement row) instead of stamping location_id. */
  target_container_kind: string | null;
  target_container_id: string | null;
  /** Suggested home from where similar items live (services/suggest-location.ts).
   *  A hint for the review UI, never applied without the user accepting it. */
  suggested_location_id: string | null;
  suggested_location_note: string | null;
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
  /** Human title for the session header. A receipt session sets e.g.
   *  "Receipt · Home Depot" (or "Receipt" when the vendor is unknown); a plain
   *  scan session leaves it null (the inbox shows the timestamp). */
  label: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** Where the session came from — "email" makes the inbox say "emailed <when>".
   *  Null for an ordinary in-app scan session. */
  origin: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** When this session was IMPORTED from another instance: the source batch id,
   *  which is the dedupe key for repeat syncs. Separate from `origin` so the
   *  provenance stamp cannot overwrite where the session actually came from. */
  import_source_id: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** The ORIGINAL source a receipt session was parsed from — the core-files id of
   *  the uploaded PDF/photo, or the emailed body captured as a file. Powers "View
   *  original" (rendered in an iframe, any type) + "Re-parse". Null for a plain
   *  scan session. */
  source_file_id: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** Receipt vendor + order/invoice number as their own fields, so the user can
   *  EDIT the order # and we recompute `label` = "Receipt · <vendor> #<ref>". */
  vendor: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  order_ref: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** The parcel's tracking number, when the receipt is for something still on
   *  its way. Its presence is what files the order as in-transit rather than
   *  arrived — see the receipt-confirm handler. */
  tracking_number: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** Where the parcel is, as last answered by core-shipments. Kept on the batch
   *  so a receipt still waiting in the inbox is followed too — filing it into an
   *  order is a bookkeeping decision, and the parcel moves either way. */
  shipment_state: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  shipment_description: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  shipment_location: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  shipment_checked_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  shipment_next_poll_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
  shipment_notified_state: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  /** The purchases order this receipt became, created at PARSE time. Null means
   *  "parsed before that moved" — the confirm handler branches on exactly that,
   *  attaching when an order exists and creating when it does not. See
   *  docs/design-decisions/order-at-parse.md. */
  purchases_order_id: ColumnType<string | null, string | null | undefined, string | null | undefined>;
}

/** A stored Guided Organize plan (services/organize-plan.ts). Apply validates
 *  group ids + destinations against this payload, so what applies is exactly
 *  what was shown, and a reload mid-session can resume. */
export interface CoreScanOrganizePlansTable {
  id: Generated<string>;
  /** Monotonic insertion-order key (bigserial). Ordering by (created_at desc,
   *  seq desc) makes "newest plan wins" deterministic — created_at alone can
   *  tie for plans minted in the same clock tick (0010_organize_plan_seq). */
  seq: Generated<string>;
  payload: Record<string, unknown>;
  applied_group_ids: Generated<unknown[]>;
  /** Put-away-walk progress: { placed_item_ids: string[] }. Bookkeeping only —
   *  filing happened at apply; this is the resumable checklist. */
  walk_state: Generated<Record<string, unknown>>;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  expires_at: Date;
}

/** Put-away sessions (docs/product/put-away.md §2.2) — the one resumable
 *  execution engine under both tempos. mode='plan' = the Guided Organize walk
 *  (state = { placed_item_ids }); mode='live' = Live Sort (state = { entries,
 *  sticky }). Ephemeral working state, swept on expiry like plans. */
export interface CoreScanPutawaySessionsTable {
  id: Generated<string>;
  mode: "plan" | "live";
  plan_id: string | null;
  catch_all_location_id: string | null;
  state: Generated<Record<string, unknown>>;
  created_by_user_id: string | null;
  created_at: Generated<Date>;
  ended_at: Date | null;
  expires_at: Date;
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

/** The identifier-decoder registry's shared cache (migration 0011). Generic
 *  across decoders (keyed by decoder_id + code); the VIN decoder is the first
 *  customer. `unavailable` outcomes are never written here — only hit/partial
 *  (expires_at null) and durable miss (expires_at set). See
 *  services/identifier-registry.ts + docs/design-decisions/vin-decode.md §6. */
export interface CoreScanDecodeCacheTable {
  decoder_id: string;
  code: string;
  outcome: string;
  fields: Generated<Record<string, unknown>>;
  provenance: string | null;
  note: string | null;
  raw: Record<string, unknown> | null;
  fetched_at: Generated<Date>;
  expires_at: Date | null;
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

/** Always-on AI catalog-photo ranking: the per-workspace opt-in (singleton row).
 *  ABSENT row == off, so a workspace that never opts in spends nothing. */
export interface CoreScanPhotoRankConfigTable {
  id: Generated<boolean>;
  enabled: Generated<boolean>;
  updated_at: Generated<Date>;
}

export interface CoreScanDB {
  core_scan_photo_rank_config: CoreScanPhotoRankConfigTable;
  core_scan_inbox_items: CoreScanInboxItemsTable;
  core_scan_batches: CoreScanBatchesTable;
  core_scan_organize_plans: CoreScanOrganizePlansTable;
  core_scan_putaway_sessions: CoreScanPutawaySessionsTable;
  core_scan_barcode_cache: CoreScanBarcodeCacheTable;
  core_scan_decode_cache: CoreScanDecodeCacheTable;
  core_scan_eval_cases: CoreScanEvalCasesTable;
  core_scan_qr_rules: CoreScanQrRulesTable;
  core_scan_import_runs: CoreScanImportRunsTable;
}

/** One bulk import, with everything needed to reverse it. An import can touch
 *  hundreds of rows at once and, with duplicate_policy=replace, OVERWRITE rows
 *  that were already there - so the before-state is recorded rather than lost,
 *  and "that import was wrong" has an answer that is not "restore a backup". */
export interface CoreScanImportRunsTable {
  id: Generated<string>;
  created_at: Generated<Date>;
  created_by_user_id: string | null;
  source_instance: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  source_label: ColumnType<string | null, string | null | undefined, string | null | undefined>;
  item_count: ColumnType<number, number | undefined, number | undefined>;
  created_count: ColumnType<number, number | undefined, number | undefined>;
  replaced_count: ColumnType<number, number | undefined, number | undefined>;
  /** { created_item_ids, created_batch_ids, replaced: [{ id, before }] } */
  undo: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown> | undefined
  >;
  undone_at: ColumnType<Date | null, Date | null | undefined, Date | null | undefined>;
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
