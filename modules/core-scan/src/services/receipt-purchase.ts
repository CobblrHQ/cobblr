// A receipt kept as a purchase, now or when Purchases is turned on (#3869).
//
// The order is born when the receipt is read (order-at-parse.md). A fresh
// workspace has Purchases off, so that call answered 409 module_not_enabled,
// the order was skipped as "survivable", and nobody was told: the receipt was
// in the inbox and in no purchase. Now the skip is a state the session keeps.
// What the order WOULD have been is stored on it (`pending_purchase`), the
// session says "Turn on Purchases to keep this as a purchase", and one tap
// turns it on and records exactly the order the read would have made, through
// this one function, the same one the read itself calls.

import { sql, type Kysely } from "kysely";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { addOrderLine, deleteOrderLine, orderLines, tryCreateReceiptOrder, type ReceiptOrderInput } from "./receipt-order.js";

export interface PendingPurchaseLine {
  description: string;
  qty: number;
  unitCost: number | null;
  lineAmount: number | null;
  /** A line that is not a thing: a charge, or a bill of sale's add-on. */
  kind?: "charge" | "add-on";
}

/** Everything the order needs, as read from the receipt: what is stored on
 *  the session while Purchases is off. */
export interface PendingPurchase extends Omit<ReceiptOrderInput, "baseUrl" | "slug" | "headers"> {
  lines: PendingPurchaseLine[];
  /** The inbox rows the read made, in receipt order: rows[i] is lines[i],
   *  null for a line that is not a thing (a charge, an add-on). */
  rowIds: Array<string | null>;
  /** The item this paperwork was attached to, when it was. */
  targetItemId: string | null;
}

export interface PurchaseHttp {
  baseUrl: string;
  slug: string;
  headers: Record<string, string>;
}

export type RecordOutcome =
  | { recorded: true; orderId: string }
  | { recorded: false; purchasesOff: boolean };

/** Record the receipt's order, its lines, and each row's claim on its line.
 *  When Purchases is off the plan is kept on the session instead, so it can
 *  be recorded later; any other failure is survivable, as it always was. */
export async function recordReceiptPurchase(
  db: Kysely<CoreScanDB>,
  batchId: string,
  plan: PendingPurchase,
  http: PurchaseHttp,
): Promise<RecordOutcome> {
  const { lines, rowIds, targetItemId, ...order } = plan;
  const made = await tryCreateReceiptOrder({ ...order, ...http });
  if (!made.id) {
    if (made.purchasesOff) {
      await db
        .updateTable("core_scan_batches")
        .set({ pending_purchase: JSON.stringify(plan) })
        .where("id", "=", batchId)
        .execute();
    }
    return { recorded: false, purchasesOff: made.purchasesOff };
  }
  const orderId = made.id;
  await db
    .updateTable("core_scan_batches")
    .set({ purchases_order_id: orderId, pending_purchase: null })
    .where("id", "=", batchId)
    .execute();
  // One order line per receipt line, in receipt order - the same order the
  // read made the inbox rows in - and each row remembers its line, which is
  // what lets a later confirm CLAIM it rather than add a second one.
  const lineIds: Array<string | null> = [];
  for (const line of lines) {
    lineIds.push(await addOrderLine({ ...http, orderId, description: line.description, qty: line.qty, unitCost: line.unitCost, lineAmount: line.lineAmount, kind: line.kind }));
  }
  for (let i = 0; i < rowIds.length; i++) {
    const lineId = lineIds[i] ?? null;
    const rowId = rowIds[i];
    if (!lineId || !rowId) continue;
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ receipt_order_id: orderId, receipt_order_item_id: lineId }) as never })
      .where("id", "=", rowId)
      .execute();
    // A pack that split into its parts before its order existed.
    await afterLineLinked(db, rowId, http);
  }
  // The item this paperwork was attached to now knows its purchase. A
  // user-owned key: an AI re-run has no standing to forget which receipt a
  // person filed.
  if (targetItemId) {
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_metadata: mergeMeta({ purchases_order_id: orderId, receipt_group_id: plan.groupId }) as never,
        updated_at: new Date(),
      })
      .where("id", "=", targetItemId)
      .execute();
  }
  return { recorded: true, orderId };
}

/** A receipt read again whose session already has its order: the read made
 *  new inbox rows, and each must claim its line on THAT order, or filing them
 *  adds things and leaves the purchase's lines unclaimed. Each row takes the
 *  order's line with the same words, one line per row; a line the order
 *  lacks is added. An order that is gone is recorded afresh. */
export async function relinkReceiptPurchase(
  db: Kysely<CoreScanDB>,
  batchId: string,
  orderId: string,
  plan: PendingPurchase,
  http: PurchaseHttp,
): Promise<RecordOutcome> {
  const existing = await orderLines({ ...http, orderId });
  if (!existing) return recordReceiptPurchase(db, batchId, plan, http);
  const words = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const taken = new Set<string>();
  for (let i = 0; i < plan.lines.length; i++) {
    const rowId = plan.rowIds[i];
    const line = plan.lines[i]!;
    if (!rowId) continue;
    const same = existing.filter((l) => !taken.has(l.id) && words(l.description) === words(line.description));
    // A line already filed stands for its thing; a second row never takes it.
    if (same.length && same.every((l) => l.part_id)) continue;
    const hit = same.find((l) => !l.part_id);
    const lineId = hit?.id ?? (await addOrderLine({ ...http, orderId, description: line.description, qty: line.qty, unitCost: line.unitCost, lineAmount: line.lineAmount, kind: line.kind }));
    if (!lineId) continue;
    taken.add(lineId);
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ receipt_order_id: orderId, receipt_order_item_id: lineId }) as never })
      .where("id", "=", rowId)
      .execute();
    await afterLineLinked(db, rowId, http);
  }
  return { recorded: true, orderId };
}

/** The plan stored on a session, when it is one. */
export function pendingPurchaseOf(raw: unknown): PendingPurchase | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object") return null;
  const p = v as Partial<PendingPurchase>;
  return Array.isArray(p.lines) && Array.isArray(p.rowIds) && typeof p.groupId === "string" ? (p as PendingPurchase) : null;
}

/** A pack line split into its parts (pack-parts.ts) splits its order line
 *  the same way (#5719): each part gets its own line on the purchase, with
 *  its own amount, and claims it when it is filed, so ten spools are ten
 *  bought things and none is displaced by the next one's claim. The pack's
 *  own line is removed once every part has one. Runs whichever lands second,
 *  the split or the order: the first caller to mark the row does it, so the
 *  two never both add lines. */
export async function splitOrderLineForParts(db: Kysely<CoreScanDB>, parentId: string, http: PurchaseHttp): Promise<boolean> {
  const parent = await db.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", parentId).executeTakeFirst();
  const pm = (parent?.suggested_metadata ?? {}) as { receipt_order_id?: unknown; receipt_order_item_id?: unknown; split_into?: unknown; order_line_split?: unknown };
  const orderId = typeof pm.receipt_order_id === "string" ? pm.receipt_order_id : null;
  const lineId = typeof pm.receipt_order_item_id === "string" ? pm.receipt_order_item_id : null;
  const parts = Array.isArray(pm.split_into) ? (pm.split_into as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (!orderId || !lineId || parts.length === 0 || pm.order_line_split) return false;
  const claimed = await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: mergeMeta({ order_line_split: true }) as never })
    .where("id", "=", parentId)
    .where(sql<boolean>`not (coalesce(suggested_metadata, '{}'::jsonb) ? 'order_line_split')`)
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) return false;
  return relineRows(db, http, orderId, [lineId], parts);
}

/** Give each row its own line on the order (its words, quantity and
 *  amount), then drop the lines it replaces (#5719, #5734). An unclaimed line
 *  with a row's words is taken before one is added, so a re-read never
 *  doubles the purchase. The old lines go only once every row has a line: a
 *  line left over is put right by the next pass, a missing one is spend
 *  lost. */
export async function relineRows(db: Kysely<CoreScanDB>, http: PurchaseHttp, orderId: string, oldLineIds: readonly string[], rowIds: readonly string[]): Promise<boolean> {
  if (rowIds.length === 0) return false;
  const rows = await db.selectFrom("core_scan_inbox_items").select(["id", "suggested_name", "quantity", "suggested_metadata"]).where("id", "in", [...rowIds]).execute();
  const words = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const free = ((await orderLines({ ...http, orderId })) ?? []).filter((l) => !l.part_id && !oldLineIds.includes(l.id));
  const taken = new Set<string>();
  let all = true;
  for (const id of rowIds) {
    const r = rows.find((x) => x.id === id);
    if (!r) continue;
    const m = (r.suggested_metadata ?? {}) as { line_total?: unknown; unit_price?: unknown };
    const qty = Number(r.quantity ?? 1) || 1;
    const amount = typeof m.line_total === "number" ? m.line_total : null;
    const reuse = free.find((l) => !taken.has(l.id) && words(l.description) === words(r.suggested_name));
    const made = reuse?.id ?? (await addOrderLine({ ...http, orderId, description: r.suggested_name ?? "", qty, unitCost: typeof m.unit_price === "number" ? m.unit_price : null, lineAmount: amount }));
    if (!made) {
      all = false;
      continue;
    }
    taken.add(made);
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ receipt_order_id: orderId, receipt_order_item_id: made }) as never })
      .where("id", "=", id)
      .execute();
  }
  if (all) for (const old of oldLineIds) await deleteOrderLine({ ...http, orderId, itemId: old });
  return all;
}

const linkOf = (meta: unknown): { orderId: string; lineId: string } | null => {
  const m = (meta ?? {}) as { receipt_order_id?: unknown; receipt_order_item_id?: unknown };
  return typeof m.receipt_order_id === "string" && typeof m.receipt_order_item_id === "string" ? { orderId: m.receipt_order_id, lineId: m.receipt_order_item_id } : null;
};

/** A line's units changed shape after its order line was made (split off,
 *  put back, a split undone): the order follows. `rowIds` are the rows that
 *  now stand for what `fromRowIds`' lines did. Nothing to do before the
 *  order exists; its stamp follows the rows then (afterLineLinked). */
export async function relineAfterChange(db: Kysely<CoreScanDB>, http: PurchaseHttp, fromRowIds: readonly string[], rowIds: readonly string[]): Promise<boolean> {
  const from = await db.selectFrom("core_scan_inbox_items").select(["id", "suggested_metadata"]).where("id", "in", [...fromRowIds]).execute();
  const links = from.map((r) => linkOf(r.suggested_metadata)).filter((l): l is { orderId: string; lineId: string } => !!l);
  if (links.length === 0) return false;
  const orderId = links[0]!.orderId;
  return relineRows(db, http, orderId, [...new Set(links.filter((l) => l.orderId === orderId).map((l) => l.lineId))], rowIds);
}

/** Once a row is linked to its order line: a row already split into parts,
 *  or with parts split off, hands the order the same shape. */
export async function afterLineLinked(db: Kysely<CoreScanDB>, rowId: string, http: PurchaseHttp): Promise<void> {
  const row = await db.selectFrom("core_scan_inbox_items").select(["suggested_metadata"]).where("id", "=", rowId).executeTakeFirst();
  const m = (row?.suggested_metadata ?? {}) as { split_into?: unknown; split_off_into?: unknown };
  if (Array.isArray(m.split_into) && m.split_into.length) {
    await splitOrderLineForParts(db, rowId, http);
    return;
  }
  const offs = Array.isArray(m.split_off_into) ? (m.split_off_into as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (offs.length) await relineAfterChange(db, http, [rowId], [rowId, ...offs]);
}
