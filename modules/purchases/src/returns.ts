// A return: the one place one is started, moved along and settled, whichever
// door said so (the order page, the assistant, a store's email).
//
// A return is a row on its order (0011), at its furthest stage:
//   requested → dropped_off → received → refunded, or cancelled before the
//   store has it.
// Stages only move forward. An email that arrives late ("dropped off" after
// the person already pressed "Received") is kept in the history and changes
// nothing; "cancelled" is refused once the store has the item.
//
// Two consequences, each happening once, stamped in the statement that
// decides them so a second door, a retry or two people at once find nothing
// left to do:
//   - stock: when the return reaches "received" (or "refunded", which means
//     the store has it), the line's count comes off the shelf. Through the
//     stock wire, the way an arrival adds it (receive.ts): an event, never a
//     write into inventory. stock_returned_at holds the once.
//   - spend: a refund comes off the order's total in orderTotal(), so every
//     spend figure nets it out. The amount is a column, set, never added to,
//     so an email saying "refund issued $12" after a person typed $12 is one
//     refund, not two.
//
// Which return a step belongs to: the one named; a person or the assistant
// starting one always starts a new one; otherwise (a store's email, which
// cannot name ours) the return on the same line, else the one whose item the
// words name, else the only one, looking at open returns before refunded ones
// and never at a cancelled one. A step that matches none starts a new return,
// except "cancelled", which with nothing to cancel is about the order itself
// (the caller decides).

import { sql, type Kysely, type Transaction } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { fieldCurrency, roundMoneyAmount } from "@cobblr/platform-contract/money";
import type { PurchasesDB, ReturnStage } from "./db.js";
import { ORDER_ITEM_RETURNED_KEYS } from "./return-keys.js";

export const RETURN_STAGES = ["requested", "dropped_off", "received", "refunded", "cancelled"] as const satisfies readonly ReturnStage[];

/** The forward order. cancelled sits outside it. */
const RANK: Record<ReturnStage, number> = { requested: 1, dropped_off: 2, received: 3, refunded: 4, cancelled: 0 };

/** The stages at which the store has the item, so it is off the shelf. */
const OFF_SHELF: ReadonlySet<ReturnStage> = new Set(["received", "refunded"]);

export const RETURN_WORDS: Record<ReturnStage, string> = {
  requested: "return started",
  dropped_off: "return dropped off",
  received: "return received by the store",
  refunded: "refund issued",
  cancelled: "return cancelled",
};

export type ReturnSource = "person" | "email" | "assistant";

export interface ReturnStep {
  orgId: string;
  orderId: string;
  stage: ReturnStage;
  /** The return this step is about, when the caller knows it. */
  returnId?: string | null;
  lineId?: string | null;
  item?: string | null;
  qty?: number | null;
  reason?: string | null;
  refundAmount?: number | null;
  at?: string;
  by: string | null;
  source: ReturnSource;
  /** Undo only: move BACK to this stage, reversing what the later stages did. */
  revert?: boolean;
}

export interface ReturnRow {
  id: string;
  order_id: string;
  line_id: string | null;
  item: string | null;
  qty: string;
  reason: string | null;
  stage: ReturnStage;
  refund_amount: string | null;
  refunded_at: Date | null;
  stock_returned_at: Date | null;
  steps: Array<{ stage: ReturnStage; at: string; by: string | null; source: ReturnSource; refund_amount?: number | null; ignored?: boolean }>;
  created_at: Date;
}

export interface StepOutcome {
  /** null: a cancellation that matched no return (the order's own business). */
  ret: ReturnRow | null;
  created: boolean;
  /** The stage before this step, for undo. */
  from: ReturnStage | null;
  /** Whether the step moved the stage (false: kept in history only). */
  moved: boolean;
  stockReturned: boolean;
  stockRestored: boolean;
}

type Line = { id: string; part_id: string | null; description: string | null; qty: string; unit_cost: string | null; line_amount: string | null };

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function namesLine(words: string, line: Pick<Line, "description">): boolean {
  const d = lower(line.description);
  const w = words.slice(0, 40);
  return w.length > 3 && d.length > 0 && (d.includes(w) || w.includes(d));
}

/** Record one step of a return. Throws ActionRefusal for a step a person
 *  asked for that cannot happen (too many, cancelling what the store has). */
export async function recordReturnStep(db: Kysely<PurchasesDB>, step: ReturnStep): Promise<StepOutcome> {
  const at = step.at ?? new Date().toISOString();
  const main = await platform().money.currency(step.orgId);
  const outcome = await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`purchases-return:${step.orderId}`}, 0))`.execute(trx);
    const order = await trx.selectFrom("purchases_orders").select(["id", "instance", "metadata"]).where("id", "=", step.orderId).executeTakeFirst();
    if (!order) throw new ActionRefusal("That order is gone.");
    const currency = fieldCurrency(order.metadata, "total_cost", main);
    const lines = (await trx
      .selectFrom("purchases_order_items")
      .select(["id", "part_id", "description", "qty", "unit_cost", "line_amount"])
      .where("order_id", "=", step.orderId)
      .execute()) as Line[];
    const all = (await trx.selectFrom("purchases_returns").selectAll().where("order_id", "=", step.orderId).orderBy("created_at").execute()) as unknown as ReturnRow[];
    // Open returns first, then settled ones: a store repeating "refund
    // issued" for a return already refunded is that return, never a second
    // refund. Only a cancelled return is out of reach.
    const open = [
      ...all.filter((r) => r.stage !== "cancelled" && r.stage !== "refunded"),
      ...all.filter((r) => r.stage === "refunded"),
    ];
    const words = lower(step.item);

    let target: ReturnRow | undefined;
    if (step.returnId) {
      target = all.find((r) => r.id === step.returnId);
      if (!target) throw new ActionRefusal("That return is not on this order.");
    } else if (step.stage === "requested" && step.source !== "email") {
      // A person or the assistant starting a return starts one: two bags of
      // the same line can go back separately. Only a store's email, which
      // cannot name our return, is matched to one already open.
      target = undefined;
    } else if (step.lineId) {
      target = open.find((r) => r.line_id === step.lineId);
    } else if (words) {
      target = open.find((r) => (r.item && (lower(r.item).includes(words.slice(0, 40)) || words.includes(lower(r.item)))) || (r.line_id && lines.some((l) => l.id === r.line_id && namesLine(words, l))));
    } else if (open.length === 1) {
      target = open[0];
    }

    if (!target) {
      if (step.stage === "cancelled" || step.revert) return { ret: null, created: false, from: null, moved: false, stockReturned: false, stockRestored: false };
      const line = step.lineId ? lines.find((l) => l.id === step.lineId) : words ? lines.find((l) => namesLine(words, l)) : lines.length === 1 ? lines[0] : undefined;
      if (step.lineId && !line) throw new ActionRefusal("That line is not on this order.");
      const qty = step.qty ?? 1;
      if (line) {
        const already = all.filter((r) => r.line_id === line.id && r.stage !== "cancelled").reduce((s, r) => s + Number(r.qty), 0);
        if (step.source !== "email" && already + qty > Number(line.qty)) {
          throw new ActionRefusal(`Only ${Number(line.qty) - already} of that line can still be returned.`);
        }
      }
      const created = (await trx
        .insertInto("purchases_returns")
        .values({
          order_id: step.orderId,
          line_id: line?.id ?? null,
          item: step.item?.trim() || line?.description || null,
          qty,
          reason: step.reason?.trim() || null,
          stage: "requested",
          steps: JSON.stringify([]),
          created_by: step.by,
          instance: order.instance,
        })
        .returningAll()
        .executeTakeFirstOrThrow()) as unknown as ReturnRow;
      target = created;
      const moved = await applyStage(trx, created, { ...step, stage: step.stage }, at, lines, true, currency);
      return { ...moved, created: true, from: null };
    }

    const moved = await applyStage(trx, target, step, at, lines, false, currency);
    return { ...moved, created: false, from: target.stage };
  });

  const ret = outcome.ret;
  if (ret && outcome.stockReturned) await tellStock(step.orgId, ret, -1);
  if (ret && outcome.stockRestored) await tellStock(step.orgId, ret, +1);
  return outcome;
}

async function applyStage(
  trx: Transaction<PurchasesDB>,
  ret: ReturnRow,
  step: ReturnStep,
  at: string,
  lines: Line[],
  fresh: boolean,
  currency: string,
): Promise<Omit<StepOutcome, "created" | "from">> {
  const steps = Array.isArray(ret.steps) ? [...ret.steps] : [];
  const from = ret.stage;
  let to: ReturnStage = from;
  if (step.revert) {
    to = step.stage;
  } else if (step.stage === "cancelled") {
    if (OFF_SHELF.has(from)) {
      if (step.source !== "email") throw new ActionRefusal("The store already has it, so this return can no longer be cancelled.");
    } else to = "cancelled";
  } else if (from !== "cancelled" && RANK[step.stage] > RANK[from]) {
    to = step.stage;
  } else if (from === "cancelled" && step.source !== "email" && !fresh) {
    throw new ActionRefusal("This return was cancelled. Start a new one instead.");
  }
  const moved = to !== from || fresh;
  steps.push({ stage: step.stage, at, by: step.by, source: step.source, ...(step.refundAmount != null ? { refund_amount: step.refundAmount } : {}), ...(to !== step.stage ? { ignored: true } : {}) });

  // The refund: an amount given is the amount (set, not added). Reaching
  // "refunded" with none prefills the line's cost for what was returned.
  const line = ret.line_id ? lines.find((l) => l.id === ret.line_id) : undefined;
  let refund = ret.refund_amount == null ? null : Number(ret.refund_amount);
  if (step.refundAmount != null && (to === "refunded" || from === "refunded")) refund = step.refundAmount;
  if (to === "refunded" && refund == null && line) {
    const each = line.unit_cost != null ? Number(line.unit_cost) : line.line_amount != null && Number(line.qty) > 0 ? Number(line.line_amount) / Number(line.qty) : null;
    if (each != null) refund = roundMoneyAmount(each * Number(ret.qty), currency);
  }
  const leavingRefund = step.revert && from === "refunded" && to !== "refunded";

  const updated = (await trx
    .updateTable("purchases_returns")
    .set({
      stage: to,
      refund_amount: leavingRefund ? null : refund,
      refunded_at: to === "refunded" ? (ret.refunded_at ? ret.refunded_at.toISOString() : at) : leavingRefund ? null : ret.refunded_at ? ret.refunded_at.toISOString() : null,
      steps: JSON.stringify(steps),
      updated_at: new Date(),
    })
    .where("id", "=", ret.id)
    .returningAll()
    .executeTakeFirstOrThrow()) as unknown as ReturnRow;

  // The shelf, once each way. Off when the store has it; back on only when an
  // undo takes the return back before the store had it.
  let stockReturned = false;
  let stockRestored = false;
  if (OFF_SHELF.has(to)) {
    const r = await sql<{ id: string }>`update purchases_returns set stock_returned_at = ${at} where id = ${ret.id} and stock_returned_at is null returning id`.execute(trx);
    stockReturned = r.rows.length > 0;
  } else if (step.revert) {
    const r = await sql<{ id: string }>`update purchases_returns set stock_returned_at = null where id = ${ret.id} and stock_returned_at is not null and not moved_in returning id`.execute(trx);
    stockRestored = r.rows.length > 0;
  }
  return { ret: { ...updated, stock_returned_at: stockReturned ? new Date(at) : stockRestored ? null : updated.stock_returned_at }, moved, stockReturned, stockRestored };
}

async function tellStock(orgId: string, ret: ReturnRow, sign: -1 | 1): Promise<void> {
  if (!ret.line_id) return;
  const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
  const line = await db.selectFrom("purchases_order_items").select(["id", "part_id", "description"]).where("id", "=", ret.line_id).executeTakeFirst();
  if (!line?.part_id) return;
  const qty = Number(ret.qty);
  const payload: { orgId: string } & Record<(typeof ORDER_ITEM_RETURNED_KEYS)[number], unknown> = {
    orgId,
    orderId: ret.order_id,
    orderItemId: line.id,
    returnId: ret.id,
    partId: line.part_id,
    delta: sign * qty,
    qty,
    reason: sign < 0 ? `Returned to the store (${line.description ?? "item"})` : `Return undone (${line.description ?? "item"})`,
    description: line.description,
  };
  await platform().events.emit("purchases.order_item.returned", payload);
}

export async function listReturns(db: Kysely<PurchasesDB>, orderId: string): Promise<ReturnRow[]> {
  return (await db.selectFrom("purchases_returns").selectAll().where("order_id", "=", orderId).orderBy("created_at").execute()) as unknown as ReturnRow[];
}
