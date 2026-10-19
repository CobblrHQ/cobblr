// One delivery, one answer. A receipt and the purchase order made from it
// describe the same box, so "it turned up" said to either settles both.
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import type { CoreScanDB } from "../db.js";

const ARRIVED_EVENT = "purchases.order.arrived";

export async function confirmReceiptAndItsOrder(
  ctx: { orgId: string; userId?: string | null },
  batchId: string,
): Promise<Record<string, unknown>> {
  const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreScanDB>;
  const row = await db
    .selectFrom("core_scan_batches")
    .select(["id", "shipment_confirmed_at", "purchases_order_id"])
    .where("id", "=", batchId)
    .executeTakeFirst();
  if (!row) return { ok: false, error: "receipt not found" };
  // Idempotent: two devices, or a stale card, answering twice is harmless.
  if (row.shipment_confirmed_at) return { ok: true, skipped: "already confirmed" };
  // The order first: if it cannot be marked, the receipt stays asking rather
  // than reading done over an order still open.
  if (row.purchases_order_id) {
    const r = await platform().actions.invoke("purchases:mark-arrived", {
      ...ctx,
      args: { orderId: row.purchases_order_id },
    } as never);
    // Declined is fine (already in hand); only a refusal stops the answer.
    if (!actionActed(r) && (r as { ok?: unknown; skipped?: unknown } | null)?.ok === false && !(r as { skipped?: unknown }).skipped) {
      return { ok: false, error: "The order could not be marked arrived, so the receipt stays open." };
    }
  }
  await db.updateTable("core_scan_batches").set({ shipment_confirmed_at: new Date() }).where("id", "=", batchId).execute();
  return { ok: true, confirmed: true };
}

/** The order arrived by its own button or page: the receipts made it are done. */
export async function confirmReceiptsOfOrder(orgId: string, orderId: string): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreScanDB>;
  await db
    .updateTable("core_scan_batches")
    .set({ shipment_confirmed_at: new Date() })
    .where("purchases_order_id", "=", orderId)
    .where("shipment_confirmed_at", "is", null)
    .execute();
}

export function startReceiptAnswerSync(): void {
  platform().events.on(ARRIVED_EVENT, "core-scan", async (payload: unknown) => {
    const p = payload as { orgId?: string; orderId?: string };
    if (!p.orgId || !p.orderId) return;
    try {
      await confirmReceiptsOfOrder(p.orgId, p.orderId);
    } catch (err) {
      platform().health.notePassFailure("core-scan.receipt-answer-sync", p.orgId, err);
      console.error("[core-scan] confirming an arrived order's receipts failed:", (err as Error).message);
    }
  });
}
