// Arrived damaged (#8854): a scan of something a delivery brought in
// damaged. The scan settles without adding anything to stock, and the row
// keeps who said so, when, what was wrong and the thing it matched, for the
// owner checking the delivery (scan-arrived-damaged.ts in the contract).
// Undo is the scan's own Undo (POST /inbox/:id/unconfirm): the mark comes
// off and the scan is back in the inbox.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ARRIVED_DAMAGED_KEY, type ScanArrivedDamaged } from "@cobblr/platform-contract/scan-arrived-damaged";
import { FILED_BY_KEY, scanFilingRefusal } from "@cobblr/platform-contract/scan-recovery";
import { scanBrokenTarget, scanPurpose, type ScanTriageRow } from "@cobblr/platform-contract/scan-triage";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { appendScanHistory } from "./scan-history.js";
import type { ActOnRow } from "./who-did-it.js";

export type ArrivedDamagedResult =
  | { ok: true; item: Record<string, unknown>; damaged: ScanArrivedDamaged }
  | { ok: false; status: 404 | 409; code: string; message: string };

export async function markArrivedDamaged(db: Kysely<CoreScanDB>, orgId: string, act: ActOnRow, id: string, note: string | null): Promise<ArrivedDamagedResult> {
  const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return { ok: false, status: 404, code: "not_found", message: "inbox item not found" };
  const refused = scanFilingRefusal(row);
  if (refused) return { ok: false, status: 409, ...refused };
  if (scanPurpose(row as unknown as ScanTriageRow) !== "arrival") {
    return { ok: false, status: 409, code: "not_an_arrival", message: "Only something that arrived can arrive damaged. Discard this scan instead." };
  }
  // The thing it matched by its code, the same one-thing rule as Broken.
  const target = scanBrokenTarget(row as unknown as ScanTriageRow);
  const damaged: ScanArrivedDamaged = { ...act, note, record: target ? { kind: target.kind, id: target.id, title: target.title ?? null } : null };
  // Claimed in one write, so two taps or two people mark it once.
  const item = await db
    .updateTable("core_scan_inbox_items")
    .set({
      status: "resolved",
      resolved_at: new Date(),
      updated_at: new Date(),
      suggested_metadata: mergeMeta({ [ARRIVED_DAMAGED_KEY]: damaged, [FILED_BY_KEY]: act }) as never,
    })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirst();
  if (!item) {
    const now = await db.selectFrom("core_scan_inbox_items").select(["status", "suggested_metadata"]).where("id", "=", id).executeTakeFirst();
    return { ok: false, status: 409, ...((now && scanFilingRefusal(now)) ?? { code: "already_resolved", message: "This scan was already filed." }) };
  }
  await appendScanHistory(db, id, { action: "damaged", note: note ? `arrived damaged: ${note}` : "arrived damaged" });
  void platform().events.emit("core-scan.scan.arrived-damaged", { orgId, itemId: id, record: damaged.record, note });
  return { ok: true, item: item as unknown as Record<string, unknown>, damaged };
}
