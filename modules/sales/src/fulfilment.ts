// Fulfilment: take each sold line's inventory part out of stock. Reads and
// writes inventory ONLY through the platform (entities.lookup for what is on
// hand, the inventory:adjust-stock action for the draw) — never a join. This is
// the "sale → decrement stock" half of the loop; the low-stock signal that
// inventory then emits drives the reorder half.
//
// An order never ships what does not exist. The stock is read BEFORE anything
// moves, and a line short of stock refuses the whole fulfilment with a sentence
// and a door, unless the person chose to ship what is on hand. inventory's
// floor also refuses a draw below zero; before #4050 that refusal was caught,
// logged and ignored here, so the order went to fulfilled having shipped
// nothing (five phantom brackets in the #4049 walk).

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "./db.js";
import { withOrderLock } from "./order-lock.js";
import { drawStock } from "./stock-draw.js";
import { orderHappened } from "./history.js";

export interface FulfilLine {
  id: string;
  part_id: string | null;
  description: string | null;
  qty: number;
  qty_fulfilled: number;
}

export interface Shortage {
  part_id: string;
  name: string;
  needed: number;
  on_hand: number;
  /** The part's own page, from its module; null when the part is gone. */
  href: string | null;
  /** The first line that asks for it, where "Make this" plans a work order. */
  line_id: string;
}

export type FulfilDoor =
  | { kind: "make"; label: string; part_id: string; qty: number; href: string | null; line_id: string }
  | { kind: "ship_available"; label: string; qty: number };

export type FulfilMode = "all" | "available";

export type FulfilResult =
  | {
      ok: true;
      complete: boolean;
      status: SalesOrderStatus;
      shipped: Array<{ line_id: string; part_id: string; qty: number }>;
    }
  | { ok: false; code: "not_enough_stock" | "nothing_to_ship" | "already_fulfilled" | "cancelled" | "not_found"; message: string; shortages: Shortage[]; doors: FulfilDoor[] };

const FULFILMENT_REFUSAL = {
  draft: null,
  confirmed: null,
  fulfilled: "already_fulfilled",
  shipped: "already_fulfilled",
  closed: "already_fulfilled",
  cancelled: "cancelled",
} satisfies Record<SalesOrderStatus, "already_fulfilled" | "cancelled" | null>;

/** The stock door a fulfilment draws through. A record whose kind keeps its
 *  count behind this action can be sold from; stock-search.ts reads it. */
export const DRAW_ACTION = "inventory:adjust-stock";

function remaining(l: FulfilLine): number {
  return Math.max(0, l.qty - l.qty_fulfilled);
}

function count(n: number, name: string): string {
  return `${n} ${name}`;
}

/** What is on hand for each part the lines draw from. A part that no longer
 *  resolves is on hand at zero: it cannot be shipped. */
/** What a stocked record has on the shelf, in the unit it keeps its count in. */
export interface OnHand { name: string; on_hand: number; unit: string | null; href: string | null }

async function readOnHand(orgId: string, partIds: string[]): Promise<Map<string, OnHand | null>> {
  const out = new Map<string, OnHand | null>();
  for (const id of partIds) {
    const ent = await platform().entities.lookup(orgId, "inventory:part", id);
    const unit = typeof ent?.fields?.unit === "string" && ent.fields.unit.trim() ? ent.fields.unit.trim() : null;
    out.set(id, ent ? { name: ent.title, on_hand: Math.max(0, Number(ent.fields?.qty ?? 0) || 0), unit, href: ent.detailUrl ?? null } : null);
  }
  return out;
}

/** Plan a fulfilment: how much of each line ships now, and what is short. */
export async function planFulfilment(
  orgId: string,
  lines: FulfilLine[],
): Promise<{ take: Map<string, number>; shortages: Shortage[]; onHand: Map<string, OnHand | null> }> {
  const stocked = lines.filter((l) => l.part_id && remaining(l) > 0);
  const partIds = [...new Set(lines.filter((l) => l.part_id).map((l) => l.part_id!))];
  const onHand = await readOnHand(orgId, partIds);
  const left = new Map(partIds.map((id) => [id, onHand.get(id)?.on_hand ?? 0]));
  const take = new Map<string, number>();
  const needed = new Map<string, number>();
  for (const l of stocked) {
    const want = remaining(l);
    const have = left.get(l.part_id!) ?? 0;
    const n = Math.min(want, have);
    take.set(l.id, n);
    left.set(l.part_id!, have - n);
    needed.set(l.part_id!, (needed.get(l.part_id!) ?? 0) + want);
  }
  const shortages: Shortage[] = [];
  for (const id of partIds) {
    const info = onHand.get(id);
    const need = needed.get(id) ?? 0;
    const have = info?.on_hand ?? 0;
    if (need > have) {
      const line = stocked.find((l) => l.part_id === id);
      shortages.push({
        part_id: id,
        name: info?.name ?? line?.description ?? "a part that is no longer tracked",
        needed: need,
        on_hand: have,
        href: info?.href ?? null,
        line_id: line!.id,
      });
    }
  }
  return { take, shortages, onHand };
}

/** The sentence a person reads when an order is short. */
export function shortageSentence(shortages: Shortage[]): string {
  if (shortages.length === 1) {
    const s = shortages[0]!;
    return s.on_hand === 0
      ? `There are no ${s.name} in stock, and this order needs ${s.needed}.`
      : `Only ${count(s.on_hand, s.name)} in stock, and this order needs ${s.needed}.`;
  }
  const parts = shortages.map((s) => `${s.name} (${s.needed} needed, ${s.on_hand} in stock)`);
  return `Not enough stock to ship this order: ${parts.join(", ")}.`;
}

function doorsFor(shortages: Shortage[], shippable: number): FulfilDoor[] {
  const doors: FulfilDoor[] = shortages.map((s) => ({
    kind: "make",
    label: `Make ${s.needed - s.on_hand} more`,
    part_id: s.part_id,
    qty: s.needed - s.on_hand,
    href: s.href,
    line_id: s.line_id,
  }));
  if (shippable > 0) {
    doors.push({ kind: "ship_available", label: `Ship the ${shippable} you have`, qty: shippable });
  }
  return doors;
}

/** Fulfil an order, or refuse. `all` ships every line in full or nothing;
 *  `available` ships what is on hand now and leaves the rest open. The one
 *  implementation behind the route and the sales:fulfill-order action. */
export async function fulfilOrder(
  db: Kysely<SalesDB>,
  orgId: string,
  userId: string | null,
  orderId: string,
  mode: FulfilMode,
): Promise<FulfilResult> {
  return withOrderLock(db, orgId, userId, orderId, () => fulfilOrderUnderLock(db, orgId, userId, orderId, mode));
}

export async function fulfilOrderUnderLock(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, mode: FulfilMode): Promise<FulfilResult> {
  const order = await db.selectFrom("sales_orders").select(["id", "status"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return { ok: false, code: "not_found", message: "That order is not here any more.", shortages: [], doors: [] };
  const refusal = FULFILMENT_REFUSAL[order.status];
  if (refusal) {
    return { ok: false, code: refusal, message: refusal === "cancelled" ? "A cancelled order does not fulfil." : `This order is already ${order.status}.`, shortages: [], doors: [] };
  }
  const rows = await db
    .selectFrom("sales_order_items")
    .select(["id", "part_id", "description", "qty", "qty_fulfilled"])
    .where("order_id", "=", orderId)
    .orderBy("created_at")
    .execute();
  const lines: FulfilLine[] = rows.map((r) => ({
    id: r.id,
    part_id: r.part_id,
    description: r.description,
    qty: Number(r.qty) || 0,
    qty_fulfilled: Number(r.qty_fulfilled) || 0,
  }));

  const { take, shortages } = await planFulfilment(orgId, lines);
  const shippable = [...take.values()].reduce((a, b) => a + b, 0);
  if (shortages.length > 0 && mode === "all") {
    return { ok: false, code: "not_enough_stock", message: shortageSentence(shortages), shortages, doors: doorsFor(shortages, shippable) };
  }
  if (shortages.length > 0 && shippable === 0) {
    return { ok: false, code: "nothing_to_ship", message: shortageSentence(shortages), shortages, doors: doorsFor(shortages, 0) };
  }

  const shipped: Array<{ line_id: string; part_id: string; qty: number }> = [];
  for (const l of lines) {
    const n = take.get(l.id) ?? 0;
    if (!l.part_id || n <= 0) continue;
    const moved = await drawStock(db, orgId, userId, orderId, { ...l, part_id: l.part_id }, n);
    if (moved <= 0) continue;
    l.qty_fulfilled += moved;
    shipped.push({ line_id: l.id, part_id: l.part_id, qty: moved });
  }

  const complete = lines.every((l) => !l.part_id || remaining(l) === 0);
  if (!complete && shipped.length === 0) {
    const again = (await planFulfilment(orgId, lines)).shortages;
    return { ok: false, code: "nothing_to_ship", message: shortageSentence(again), shortages: again, doors: doorsFor(again, 0) };
  }
  const status: SalesOrderStatus = complete ? "fulfilled" : order.status === "draft" ? "confirmed" : order.status;
  await db
    .updateTable("sales_orders")
    .set({ status, ...(complete ? { fulfilled_at: new Date() as never } : {}), updated_at: new Date() })
    .where("id", "=", orderId)
    .execute();
  if (status !== order.status) {
    await orderHappened(db, orgId, orderId, { kind: "status", from_status: order.status, to_status: status, by_user: userId });
  }
  return { ok: true, complete, status, shipped };
}
