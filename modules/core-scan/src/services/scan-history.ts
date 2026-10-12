// A scan row's History and the before-state its rewrites keep (#6100). One
// writer for the History line and one for the snapshot ("Previously: … ·
// Revert"), so every pass that rewrites a row's identity, a person's re-run
// or a heal, records the same before-state and the same entry.
import type { Kysely } from "kysely";
import { displayName } from "@cobblr/platform-contract/display-identity";
import { mergeMeta } from "./metadata.js";
import type { CoreScanDB } from "../db.js";

export type ScanHistoryAction =
  | "rerun" | "replay" | "rerun-hint" | "hint" | "wrong" | "enrich" | "confirm" | "combine" | "uncombine" | "attached" | "split" | "unsplit" | "unconfirm" | "undo-rerun" | "barcode" | "confirm-guess" | "reject-guess" | "crop-again"
  // A heal re-judged a shop's own barcode from its photo (#6100).
  | "store-code";

/** The identity a rewrite can replace, as it stood: what Revert puts back. */
export function preRerunSnapshot(
  row: { suggested_name: string | null; suggested_manufacturer: string | null; suggested_sku: string | null; suggested_candidates: unknown; suggested_metadata: unknown; ai_notes: string | null; catalog_image_url: string | null; catalog_image_file_id: string | null },
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
    catalog_image_url: row.catalog_image_url,
    catalog_image_file_id: row.catalog_image_file_id,
  };
}

export async function appendScanHistory(
  db: Kysely<CoreScanDB>,
  id: string,
  entry: {
    action: ScanHistoryAction;
    note?: string | null;
  },
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
