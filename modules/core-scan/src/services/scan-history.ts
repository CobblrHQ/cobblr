// A scan row's History and the before-state its rewrites keep (#6100). One
// writer for the History line and one for the snapshot ("Previously: … ·
// Revert"), so every pass that rewrites a row's identity, a person's re-run
// or a heal, records the same before-state and the same entry.
import type { Kysely } from "kysely";
import { displayName } from "@cobblr/platform-contract/display-identity";
import { mergeMeta } from "./metadata.js";
import type { CoreScanDB } from "../db.js";

/** Actions that rewrite what a row shows: its name, brand, pictures, kind or
 *  code. Each writes a revision before it starts, and its History entry must
 *  carry it, so Undo and Put back can restore exactly what was there (#6100). */
export type ScanRewriteAction =
  | "rerun" | "replay" | "rerun-hint" | "hint" | "wrong" | "enrich" | "barcode" | "confirm-guess" | "reject-guess" | "crop-again"
  // A heal re-judged a shop's own barcode from its photo (#6100).
  | "store-code"
  // A heal cleared a photo read that ran on instead of naming (#6100).
  | "prose-name"
  // A heal named it from the biggest words on its label (#6100).
  | "label-name"
  // A heal cleared a label name a stricter read no longer stands behind.
  | "label-cleared"
  // A restore is a rewrite too, so it can be put back in turn.
  | "undo-rerun" | "put-back";

/** Actions that leave those fields alone, or that are one half of a pair
 *  whose other half undoes them (file/unfile, combine/uncombine,
 *  split/unsplit). They record no revision. */
export type ScanOwnInverseAction = "confirm" | "attached" | "unconfirm" | "combine" | "uncombine" | "split" | "unsplit" | "resplit";

/** A recorded before-state: its id rides on the History entry. */
export interface ScanRevision {
  id: string;
  beforeName: string | null;
  /** The brand and the confidence the step replaces (#6210): History says
   *  when a step changed them, not only the name. */
  beforeBrand: string | null;
  beforeConfidence: string | null;
}

export type ScanHistoryEntry =
  | { action: ScanRewriteAction; revision: ScanRevision; note?: string | null }
  | { action: ScanOwnInverseAction; note?: string | null };

/** Every column a rewrite can change. A put-back writes all of them back. */
export const REVISION_COLUMNS = [
  "barcode_text",
  "image_file_id",
  "catalog_image_file_id",
  "catalog_image_url",
  "suggested_name",
  "suggested_manufacturer",
  "suggested_sku",
  "suggested_metadata",
  "suggested_candidates",
  "ai_notes",
  "ai_confidence",
  "ai_suggested_at",
  "target_module",
  "target_kind",
  "target_entity_id",
  "suggested_location_id",
  "suggested_location_note",
  "quantity",
] as const;

/** Metadata a person set by a separate action, which a put-back of an older
 *  revision must not take back with the lookup it undoes. */
const KEPT_ON_PUT_BACK = ["history", "tags", "box_state", "keep_grouped", "receipt_group_id", "import_provenance"] as const;

/** What a running lookup keeps on the row while it works. A put-back is
 *  never mid-run: nothing is running to finish a before-state recorded while
 *  a lookup was in flight, so these are dropped and the run stamped done, or
 *  the card reads "AI is reading" forever (the 390 walk of #6100). */
const IN_FLIGHT_KEYS = ["pipeline_started_at", "photo_check_pending", "pending_confidence", "pending_notes", "pending_replaced"] as const;

/** Revisions kept per row: History shows the last eight entries. */
const REVISIONS_KEPT = 16;

/** Write the row's fields as they stand now, before `action` rewrites them. */
export async function recordRevision(db: Kysely<CoreScanDB>, itemId: string, action: ScanRewriteAction): Promise<ScanRevision> {
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select([...REVISION_COLUMNS])
    .where("id", "=", itemId)
    .executeTakeFirstOrThrow();
  const { history: _h, ...meta } = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const before = { ...row, suggested_metadata: meta };
  const rev = await db
    .insertInto("core_scan_item_revisions")
    .values({ item_id: itemId, action, before: JSON.stringify(before) })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .deleteFrom("core_scan_item_revisions")
    .where("item_id", "=", itemId)
    .where(
      "id",
      "not in",
      db.selectFrom("core_scan_item_revisions").select("id").where("item_id", "=", itemId).orderBy("created_at", "desc").limit(REVISIONS_KEPT),
    )
    .execute();
  return { id: rev.id, beforeName: displayName(row as never) ?? null, beforeBrand: row.suggested_manufacturer ?? null, beforeConfidence: row.ai_confidence ?? null };
}

/** The columns a put-back writes from a revision's before-state. The
 *  metadata is the before-state's, except what a person set since by another
 *  action (their tags, the History itself), which stays as it is now. */
export function revisionRestore(
  before: Record<string, unknown>,
  currentMeta: Record<string, unknown> | null,
): Record<(typeof REVISION_COLUMNS)[number], unknown> {
  const meta: Record<string, unknown> = { ...((before.suggested_metadata ?? {}) as Record<string, unknown>) };
  const cur = currentMeta ?? {};
  for (const k of KEPT_ON_PUT_BACK) {
    if (k in cur) meta[k] = cur[k];
    else delete meta[k];
  }
  const settledAt = new Date();
  // Mid-flight: no answer stamped yet, a run started and not finished, or the
  // photo gate still holding a name. A settled before-state is left exactly
  // as it was (a keyword-routed row has no matched_at, and keeps none).
  const midFlight =
    !before.ai_suggested_at || (!!meta.pipeline_started_at && !meta.finalized_at) || meta.photo_check_pending === true;
  if (midFlight) {
    for (const k of IN_FLIGHT_KEYS) delete meta[k];
    meta.finalized_at ??= settledAt.toISOString();
  }
  const out = {} as Record<(typeof REVISION_COLUMNS)[number], unknown>;
  for (const col of REVISION_COLUMNS) {
    const v = before[col] ?? null;
    out[col] =
      col === "suggested_metadata"
        ? JSON.stringify(meta)
        : col === "suggested_candidates"
          ? JSON.stringify(Array.isArray(v) ? v : [])
          : col === "ai_suggested_at"
            ? (v ? new Date(String(v)) : settledAt)
            : col === "quantity"
              ? (typeof v === "number" ? v : 1)
              : v;
  }
  return out;
}

/** Put a row back as a revision found it. Records the row as it is now
 *  first, so the put-back can itself be put back. Null when the revision is
 *  not this row's. */
export async function restoreRevision(
  db: Kysely<CoreScanDB>,
  itemId: string,
  revisionId: string,
  action: "undo-rerun" | "put-back" = "put-back",
): Promise<{ name: string | null; needsMatch: boolean } | null> {
  const rev = await db
    .selectFrom("core_scan_item_revisions")
    .select(["before"])
    .where("id", "=", revisionId)
    .where("item_id", "=", itemId)
    .executeTakeFirst();
  if (!rev) return null;
  const cur = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", itemId).executeTakeFirstOrThrow();
  const now = await recordRevision(db, itemId, action);
  const cols = revisionRestore(rev.before as Record<string, unknown>, cur.suggested_metadata as Record<string, unknown> | null);
  const back = await db
    .updateTable("core_scan_inbox_items")
    .set({ ...(cols as Record<string, unknown>), updated_at: new Date() } as never)
    .where("id", "=", itemId)
    .returningAll()
    .executeTakeFirstOrThrow();
  const name = displayName(back as never) ?? null;
  // A before-state recorded before its match finished has no route: the
  // caller finishes it (a replay match, no AI), rather than this faking a
  // matched_at that would leave the row settled with nowhere to go.
  const needsMatch = !((back.suggested_metadata ?? {}) as { matched_at?: unknown }).matched_at;
  await appendScanHistory(db, itemId, { action, revision: now, note: name ? `back to "${name}"` : null });
  return { name, needsMatch };
}

/** The identity a rewrite can replace, as it stood: what Revert puts back. */
export function preRerunSnapshot(
  row: { suggested_name: string | null; suggested_manufacturer: string | null; suggested_sku: string | null; suggested_candidates: unknown; suggested_metadata: unknown; ai_notes: string | null; ai_confidence?: string | null; catalog_image_url: string | null; catalog_image_file_id: string | null },
  kind: string,
): Record<string, unknown> {
  const meta = (row.suggested_metadata ?? {}) as { category?: unknown; entity_type?: unknown };
  return {
    at: new Date().toISOString(),
    kind,
    name: displayName(row as never),
    manufacturer: row.suggested_manufacturer,
    sku: row.suggested_sku,
    candidates: row.suggested_candidates ?? [],
    category: meta.category ?? null,
    entity_type: meta.entity_type ?? null,
    ai_notes: row.ai_notes,
    ai_confidence: row.ai_confidence ?? null,
    catalog_image_url: row.catalog_image_url,
    catalog_image_file_id: row.catalog_image_file_id,
  };
}

export async function appendScanHistory(
  db: Kysely<CoreScanDB>,
  id: string,
  entry: ScanHistoryEntry,
): Promise<void> {
  try {
    const cur = await db
      .selectFrom("core_scan_inbox_items")
      .select("suggested_metadata")
      .where("id", "=", id)
      .executeTakeFirst();
    const meta = (cur?.suggested_metadata ?? {}) as Record<string, unknown>;
    const prev = Array.isArray((meta as { history?: unknown }).history)
      ? ((meta as { history: unknown[] }).history as unknown[])
      : [];
    const e: Record<string, unknown> = { action: entry.action, at: new Date().toISOString() };
    if (entry.note && entry.note.trim()) e.note = entry.note.trim();
    if ("revision" in entry) {
      e.revision = entry.revision.id;
      e.before_name = entry.revision.beforeName;
      e.before_brand = entry.revision.beforeBrand;
      e.before_confidence = entry.revision.beforeConfidence;
    }
    // Write ONLY the history key, DB-side. This used to write the whole bag
    // back from the copy read above - a lost update that destroyed anything
    // committed in between. The replay handler writes `pre_rerun` (the
    // before-image that powers "Put it back", including the user's chosen
    // catalog photo) and then calls this to record the replay: the history
    // entry deleted the snapshot of the very action it was recording, so the
    // undo button never appeared and a hand-picked photo was unrecoverable
    // (reported 2026-08-01). `catalog_image_user_set` went the same way.
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ history: [...prev, e].slice(-8) }) as never })
      .where("id", "=", id)
      .execute();
  } catch {
    /* best-effort */
  }
}
