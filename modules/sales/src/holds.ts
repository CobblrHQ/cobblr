// A hold: a draft order that sets stock aside for a customer (#8838).
//
// Holding reserves each stocked line's quantity: inventory carries the
// reservation (so the item shows "held for <name>" and its available count
// drops) and sales_holds carries the same rows here, so a second order is told
// how much is really free before it ships the same thing. A hold ends on its
// own day, when the order is cancelled, when the order is fulfilled (the stock
// then leaves for real), or when it is released by hand.
//
// The rules, read by every door (the page, the route, the assistant):
//   - only a draft order holds, and only what stock covers after other holds;
//   - holding again replaces the hold (a new day, or after the lines changed);
//   - stock held for one order is never shipped on another.
//
// Inventory is reached only through its own actions, never a join.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import { arrivedEverywhere, isRealDay } from "@cobblr/platform-contract/day";
import type { SalesDB } from "./db.js";
import { withOrderLock } from "./order-lock.js";
import { orderHappened } from "./history.js";
import { planFulfilment, shortageSentence, type FulfilLine } from "./fulfilment.js";

export type HoldResult =
  | { ok: true; held: number; until: string | null }
  | { ok: false; code: "not_found" | "not_a_draft" | "nothing_to_hold" | "not_a_day" | "too_few"; message: string };

export type ReleaseResult = { ok: true; released: number } | { ok: false; code: "not_found"; message: string };

const TARGET_KIND = "sales:order";

/** How much of each part other orders hold, so an order is only told what is free. */
export async function heldByOthers(db: Kysely<SalesDB>, partIds: readonly string[], exceptOrderId: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!partIds.length) return out;
  let q = db.selectFrom("sales_holds").select(["part_id", sql<string>`sum(qty)`.as("qty")]).where("part_id", "in", [...partIds]);
  if (exceptOrderId) q = q.where("order_id", "!=", exceptOrderId);
  for (const r of await q.groupBy("part_id").execute()) out.set(r.part_id, Number(r.qty));
  return out;
}

async function inventory(action: string, orgId: string, userId: string | null, args: Record<string, unknown>): Promise<void> {
  try {
    const answer = await platform().actions.invoke(`inventory:${action}`, {
      orgId,
      userId,
      scope: "workspace",
      event: { name: "sales.order.held", payload: {}, actor: { user_id: userId, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" },
      args,
    });
    if (!actionActed(answer)) console.warn(`[sales] inventory:${action} did not act:`, JSON.stringify(answer));
  } catch (e) {
    // pass-catch: a workspace with no inventory still holds here, and the warning names what was skipped; the hold's own rows are the record.
    console.warn(`[sales] inventory:${action} unavailable:`, (e as Error).message);
  }
}

async function letGo(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string): Promise<number> {
  const held = await db.selectFrom("sales_holds").select(["id", "line_id"]).where("order_id", "=", orderId).execute();
  for (const h of held) await inventory("release-line", orgId, userId, { for_kind: TARGET_KIND, for_id: orderId, for_line: h.line_id });
  if (held.length) await db.deleteFrom("sales_holds").where("order_id", "=", orderId).execute();
  await db.updateTable("sales_orders").set({ held_at: null, hold_until: null }).where("id", "=", orderId).execute();
  return held.length;
}

/** A line is leaving a held order: its reservation goes first, since deleting the line would drop the rows that say what to release. */
export async function releaseLineHold(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, lineId: string): Promise<void> {
  const held = await db.selectFrom("sales_holds").select("id").where("order_id", "=", orderId).where("line_id", "=", lineId).executeTakeFirst();
  if (!held) return;
  await inventory("release-line", orgId, userId, { for_kind: TARGET_KIND, for_id: orderId, for_line: lineId });
  await db.deleteFrom("sales_holds").where("id", "=", held.id).execute();
}

/** Hold the stock of a draft order's lines, optionally until a day. */
export async function holdOrder(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, input: { until?: string | null } = {}): Promise<HoldResult> {
  return withOrderLock(db, orgId, userId, orderId, () => holdUnderLock(db, orgId, userId, orderId, input));
}

/** For a caller that already holds the order's lock (a line change). */
export async function holdUnderLock(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, input: { until?: string | null } = {}): Promise<HoldResult> {
  {
    const order = await db.selectFrom("sales_orders").select(["id", "status", "customer_name", "order_number"]).where("id", "=", orderId).executeTakeFirst();
    if (!order) return { ok: false, code: "not_found", message: "That order is not here any more." };
    if (order.status !== "draft") return { ok: false, code: "not_a_draft", message: "Only a draft order holds stock. Once it is confirmed or fulfilled, Fulfill takes the stock for real." };
    const until = input.until?.trim() || null;
    if (until !== null && !isRealDay(until)) return { ok: false, code: "not_a_day", message: "That is not a day on the calendar." };
    const rows = await db.selectFrom("sales_order_items").select(["id", "part_id", "description", "qty", "qty_fulfilled"]).where("order_id", "=", orderId).orderBy("created_at").execute();
    const lines: FulfilLine[] = rows.map((r) => ({ id: r.id, part_id: r.part_id, description: r.description, qty: Number(r.qty) || 0, qty_fulfilled: Number(r.qty_fulfilled) || 0 }));
    const stocked = lines.filter((l) => l.part_id && l.qty - l.qty_fulfilled > 0);
    if (!stocked.length) return { ok: false, code: "nothing_to_hold", message: "This order has no stocked line to hold. Add a part from your stock first." };
    const others = await heldByOthers(db, stocked.map((l) => l.part_id!), orderId);
    const { shortages } = await planFulfilment(orgId, lines, others);
    if (shortages.length) return { ok: false, code: "too_few", message: shortageSentence(shortages) };
    await letGo(db, orgId, userId, orderId);
    const who = order.customer_name?.trim() || order.order_number || "an order";
    for (const l of stocked) {
      const qty = l.qty - l.qty_fulfilled;
      await db.insertInto("sales_holds").values({ order_id: orderId, line_id: l.id, part_id: l.part_id!, qty }).execute();
      await inventory("reserve-for-line", orgId, userId, { part_id: l.part_id, qty, for_kind: TARGET_KIND, for_id: orderId, for_line: l.id, reason: `Held for ${who}` });
    }
    await db.updateTable("sales_orders").set({ held_at: new Date(), hold_until: until }).where("id", "=", orderId).execute();
    await orderHappened(db, orgId, orderId, { kind: "hold", detail: { held: stocked.length, until }, by_user: userId });
    return { ok: true, held: stocked.length, until };
  }
}

/** Let an order's hold go, for a reason a person reads in its history. */
export async function releaseHold(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, why = "released"): Promise<ReleaseResult> {
  return withOrderLock(db, orgId, userId, orderId, () => releaseHoldUnderLock(db, orgId, userId, orderId, why));
}

/** For a caller that already holds the order's lock (Fulfill, Cancel). */
export async function releaseHoldUnderLock(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, why: string): Promise<ReleaseResult> {
  const order = await db.selectFrom("sales_orders").select(["id", "held_at"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return { ok: false, code: "not_found", message: "That order is not here any more." };
  if (!order.held_at) return { ok: true, released: 0 };
  const released = await letGo(db, orgId, userId, orderId);
  await orderHappened(db, orgId, orderId, { kind: "hold", detail: { released: true, why }, by_user: userId });
  return { ok: true, released };
}

/** The lines of a held order changed: hold what they are now, or let go when stock no longer covers it. */
export async function refreshHold(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, underLock = false): Promise<void> {
  const order = await db.selectFrom("sales_orders").select(["held_at", "hold_until"]).where("id", "=", orderId).executeTakeFirst();
  if (!order?.held_at) return;
  const until = order.hold_until ? String(order.hold_until).slice(0, 10) : null;
  const r = await (underLock ? holdUnderLock : holdOrder)(db, orgId, userId, orderId, { until });
  if (!r.ok) {
    const why = `the lines changed and ${r.message.charAt(0).toLowerCase()}${r.message.slice(1)}`;
    await (underLock ? releaseHoldUnderLock(db, orgId, userId, orderId, why) : releaseHold(db, orgId, userId, orderId, why));
  }
}

/** Holds past their day let go: the hourly pass. `today` is the day that has arrived everywhere, never early. */
export async function releaseExpiredHolds(db: Kysely<SalesDB>, orgId: string, today: string): Promise<{ released: number }> {
  const due = await db.selectFrom("sales_orders").select("id").where("held_at", "is not", null).where("hold_until", "is not", null).where("hold_until", "<", today as never).execute();
  for (const o of due) await releaseHold(db, orgId, null, o.id, "its day passed");
  return { released: due.length };
}

export function registerHoldSweep(): void {
  platform().sweeps.register({
    name: "sales.holds",
    everyMs: 60 * 60 * 1000,
    module: "sales",
    visit: async ({ orgId, db, now }) => {
      try {
        return await releaseExpiredHolds(db as Kysely<SalesDB>, orgId, arrivedEverywhere(now));
      } catch (err) {
        // A workspace whose sales migrations have not caught up yet.
        if (!(err as Error).message.includes("does not exist")) throw err;
        return { released: 0 };
      }
    },
  });
}
