// One-shot heal: a receipt's repeated lines, read before they became one row.
//
// DONE WHEN: /healthz reads 0 for this shim on prod, canary, staging and app,
// meaning no pending receipt still holds the same product twice. It records the
// count itself through registerHealPass (noteHealShim). Nothing re-creates the
// shape: a read combines the lines before it makes the rows
// (withSameLinesCombined). Delete this file and its boot call then.
//
// WHY IT EXISTS: an owner's inbox held "Sweet Bell Peppers" twice, lines 3 and 4
// of one receipt at the same price (#9268). The read now makes one row; this is
// for the rows it already made. Only pending rows, and never a filed one. It goes
// through the same combine a person presses, so Undo combine returns the rows.
//
// BORN WITH: a fresh workspace has no rows, and every receipt it reads goes
// through withSameLinesCombined.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { fieldProvenanceOf } from "@cobblr/platform-contract/acquisition-source";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { KEEP_SEPARATE_KEY } from "@cobblr/platform-contract/scan-triage";
import type { CoreScanDB } from "./db.js";
import { traitsHaveUnique, type CombineCandidate } from "./services/combine-merge.js";
import { combineInboxRows, type InboxRow } from "./services/combine-rows.js";
import { filedQuantityOf } from "./services/filed-quantity.js";
import { sameProductKey } from "./services/same-receipt-lines.js";

/** Keys a row carries once a person or a later step has made it its own: a
 *  combine, a split, a slot counted by scan, a choice about its units. */
const ALREADY_SHAPED = ["combine_undo", "combined_into", "split_from", "split_into", "split_off_from", "split_off_into", "line_units", "line_received", "line_pack", "check_fields", KEEP_SEPARATE_KEY];

const topCandidate = (r: Pick<InboxRow, "suggested_candidates">) => (r.suggested_candidates as CombineCandidate[] | null)?.[0];

/** Which rows may fold into which, or null for a row left alone. Pure. */
export function repeatedLineKey(r: Pick<InboxRow, "barcode_text" | "suggested_name" | "suggested_manufacturer" | "suggested_metadata" | "suggested_candidates" | "quantity">): string | null {
  const m = (r.suggested_metadata ?? {}) as Record<string, unknown>;
  if (typeof m.receipt_group_id !== "string" || ALREADY_SHAPED.some((k) => k in m)) return null;
  if (Object.values(fieldProvenanceOf(m)).some((p) => p?.by === "person")) return null;
  const line = sameProductKey({
    code: r.barcode_text,
    description: typeof m.description === "string" ? m.description : r.suggested_name,
    model: m.model,
    manufacturer: r.suggested_manufacturer,
    unitPrice: m.unit_price,
    lineTotal: m.line_total,
    quantity: filedQuantityOf(r.quantity),
    oneOfItsOwn: !!m.weight || !!m.line_facts || !!m.decoded,
  });
  if (!line) return null;
  const top = topCandidate(r);
  // The rows must also read the same now: one named, routed or pictured
  // differently since the read is not offered as the same thing.
  return JSON.stringify([m.receipt_group_id, line, r.suggested_name, top?.module ?? null, top?.instance ?? null, top?.kind ?? null, m.order_line_image ?? null]);
}

const orderOnReceipt = (r: InboxRow) => {
  const n = Number((r.suggested_metadata as { receipt_line?: unknown } | null)?.receipt_line);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** Heal one workspace. `found` is the repeats still there after the visit: a set
 *  of lines tracked one by one, which stays as it is, and any whose kind could
 *  not be read, which the next round tries again. */
export async function healSameReceiptLinesIn(orgId: string, db: Kysely<CoreScanDB>, since: Date): Promise<{ found: number; settled: boolean }> {
  const rows = (await db
    .selectFrom("core_scan_inbox_items")
    .selectAll()
    .where("status", "=", "pending")
    .where("source_kind", "=", "receipt")
    .where("created_at", "<", since)
    .where(sql<boolean>`suggested_metadata ? 'receipt_group_id'`)
    .execute()) as InboxRow[];
  const groups = new Map<string, InboxRow[]>();
  for (const r of rows) {
    const key = repeatedLineKey(r);
    if (key) groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const repeats = [...groups.values()].filter((g) => g.length > 1);
  if (repeats.length === 0) return { found: 0, settled: true };
  const kinds = await platform().entities.listKindsForOrg(orgId).catch(() => null);
  let left = 0;
  let waiting = false;
  let combined = 0;
  for (const group of repeats) {
    const kind = topCandidate(group[0]!)?.kind;
    if (kind && !kinds) {
      left++;
      waiting = true;
      continue;
    }
    // Two lines of a thing tracked one by one are two things, each its own record.
    if (kind && traitsHaveUnique(kinds?.find((k) => k.id === kind)?.traits ?? null)) {
      left++;
      continue;
    }
    const inOrder = [...group].sort((a, b) => orderOnReceipt(a) - orderOnReceipt(b));
    await combineInboxRows(db, inOrder, inOrder[0]!.id, { lineFigures: true });
    combined++;
  }
  if (combined > 0) console.log(`[core-scan] org ${orgId}: ${combined} repeated receipt line(s) now one row`);
  return { found: left, settled: !waiting };
}

/** Call from onBoot. */
export function registerSameReceiptLinesHeal(): void {
  registerHealPass({
    name: "core-scan.heal-same-receipt-lines",
    since: "2026-11-07T00:00:00Z",
    shim: "modules/core-scan/src/heal-same-receipt-lines.ts",
    module: "core-scan",
    visit: ({ orgId, db, since }) => healSameReceiptLinesIn(orgId, db as Kysely<CoreScanDB>, since),
  });
}
