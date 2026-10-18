// The parcels an order ships in (#5351).
//
// A store that ships an order in several boxes sends one notice per box: its
// tracking number, and which of the order's lines are in it ("Items in this
// shipment: KINGROON PETG Filament × 1, US / 10KG / Multicolor"). Each box is
// a shipment; the lines it names travel in it, and the rest are "not shipped
// yet" until their own notice comes. An order that ships in one box needs none
// of this: its tracking number stays on the order, as it always has, and a
// notice that covers every line still to come is recorded there.
//
// The store's words are matched to the order's lines by what tells the lines
// apart. Three bundles of the same filament share every word but the colour,
// so a word on every line counts for nothing and the colour decides. A notice
// that matches no line confidently attaches no lines: guessing would mark the
// wrong spool as on its way.

import { sql, type Kysely } from "kysely";
import { arrivedEverywhere, platform } from "@cobblr/platform-contract";
import type { PurchasesDB } from "./db.js";
import { receiveOrderLine, receiveOrderLines, unreceiveOrderLines } from "./receive.js";

export interface ShippedItem {
  description: string;
  qty?: number | null;
}

export interface OrderLine {
  id: string;
  description: string | null;
}

function words(s: string | null | undefined): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .map((w) => w.replace(/^\.+|\.+$/g, ""))
      .filter((w) => w.length > 1 || /\d/.test(w)),
  );
}

/** The lines a new parcel carries: the ones named, or the ones a notice's
 *  items match. A parcel added by hand naming nothing, on an order already
 *  shipping in parcels, carries the lines no parcel has yet, never none and
 *  never one already in another parcel. */
export function parcelLines(
  input: { line_ids?: string[]; items?: readonly ShippedItem[] },
  open: ReadonlyArray<OrderLine & { shipment_id: string | null }>,
  known: ReadonlySet<string>,
  hasParcels: boolean,
): string[] {
  if (input.line_ids?.length) return input.line_ids.filter((id) => known.has(id));
  if (input.items?.length) return matchShippedLines(input.items, open);
  return hasParcels ? open.filter((l) => !l.shipment_id).map((l) => l.id) : [];
}

/** Which order lines the notice's items are, by the words that set each line
 *  apart from the others. An item matches the one line it shares the most
 *  telling words with, and only when no other line ties it; each line is
 *  matched at most once. Pure. */
export function matchShippedLines(items: readonly ShippedItem[], lines: readonly OrderLine[]): string[] {
  if (!items.length || !lines.length) return [];
  const lineWords = lines.map((l) => ({ id: l.id, words: words(l.description) }));
  const df = new Map<string, number>();
  for (const l of lineWords) for (const w of l.words) df.set(w, (df.get(w) ?? 0) + 1);
  const taken = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const iw = words(item.description);
    let best: { id: string; score: number } | null = null;
    let second = 0;
    for (const l of lineWords) {
      if (taken.has(l.id)) continue;
      let score = 0;
      for (const w of iw) {
        if (!l.words.has(w)) continue;
        const n = df.get(w) ?? 1;
        // A word every line has says nothing about which line this is.
        if (lines.length > 1 && n === lines.length) continue;
        score += 1 / n;
      }
      // Between "Multicolor" and "Multicolor-1", the line saying more than
      // the notice did is the worse fit: a telling word of the line's that the
      // notice never mentions costs a little, never as much as a shared one.
      if (score > 0) {
        for (const w of l.words) {
          const n = df.get(w) ?? 1;
          if (!iw.has(w) && !(lines.length > 1 && n === lines.length)) score -= 0.1 / n;
        }
      }
      if (!best || score > best.score) {
        second = best?.score ?? 0;
        best = { id: l.id, score };
      } else if (score > second) {
        second = score;
      }
    }
    if (best && best.score > 0 && best.score > second) {
      taken.add(best.id);
      out.push(best.id);
    }
  }
  return out;
}

export interface ShipmentInput {
  tracking_number: string;
  /** The store's words for what is in the box. */
  items?: ShippedItem[];
  /** The lines, when the caller already knows them (a person ticking them). */
  line_ids?: string[];
  shipment_state?: string | null;
  expected_arrival?: string | null;
  description?: string | null;
}

export interface ShipmentOutcome {
  /** "order": the box is the whole order and its number went on the order.
   *  "shipment": one box of several, with the lines it carries. */
  mode: "order" | "shipment";
  shipment_id: string | null;
  tracking_number: string;
  /** The lines in this box, in the order's own words. */
  lines: Array<{ id: string; description: string | null }>;
  /** Lines of the order still waiting for a box of their own. */
  not_shipped: Array<{ id: string; description: string | null }>;
  vendor: string | null;
  order_number: string | null;
  expected_arrival: string | null;
  created: boolean;
}

const PRE_SHIP = ["planned", "ordered"];

/** Record one parcel of an order. Idempotent per (order, number): the same
 *  notice twice, or a later "delivered" for the same box, updates it. */
export async function recordShipment(
  db: Kysely<PurchasesDB>,
  orgId: string,
  userId: string | null,
  orderId: string,
  input: ShipmentInput,
): Promise<ShipmentOutcome | null> {
  const number = input.tracking_number.replace(/\s+/g, "");
  const order = await db
    .selectFrom("purchases_orders")
    .select(["id", "vendor", "order_number", "status", "tracking_number", "expected_arrival", "arrived_at", "ordered_at", "created_at"])
    .where("id", "=", orderId)
    .executeTakeFirst();
  if (!order) return null;

  // A receipt with no tracking number and no promised day is filed as
  // ARRIVED, its lines received and their stock on the shelf. A shipping
  // notice for that order proves it was not in hand: the arrival is taken
  // back (the stock comes off until the box turns up; its spend stays
  // counted once) and the order is followed again. An arrival a person
  // confirmed later than the order is theirs, and is never undone.
  if (order.status === "arrived" && arrivedWhenFiled(order)) {
    await unreceiveOrderLines(db, orgId, orderId, "Still on its way: a shipping notice came after the receipt");
    await db.updateTable("purchases_orders").set({ status: "in-transit", arrived_at: null, updated_at: new Date() } as never).where("id", "=", orderId).execute();
    await platform().events.emit("purchases.order.status_changed", { orgId, orderId, from: "arrived", to: "in-transit" });
    order.status = "in-transit";
  }
  const lines = await db
    .selectFrom("purchases_order_items")
    .select(["id", "description", "received_at", "shipment_id"])
    .where("order_id", "=", orderId)
    .orderBy("created_at")
    .execute();
  const existing = await db
    .selectFrom("purchases_order_shipments")
    .select(["id"])
    .where("order_id", "=", orderId)
    .execute();

  const open = lines.filter((l) => !l.received_at);
  const known = new Set(lines.map((l) => l.id));
  const picked = parcelLines(input, open, known, existing.length > 0);

  const state = input.shipment_state ?? null;
  const eta = input.expected_arrival ?? null;
  const now = new Date();
  const orderNumber = (order.tracking_number ?? "").replace(/\s+/g, "");
  // The whole order in one box: what every order was before parcels. It is
  // when the notice names no lines (or none we could match) and the order has
  // no number yet, or when it names every line still to come.
  const coversAll = picked.length > 0 && open.length > 0 && open.every((l) => picked.includes(l.id));
  const wholeOrder =
    existing.length === 0 && (!orderNumber || orderNumber === number) && (picked.length === 0 || coversAll);

  if (wholeOrder) {
    await db.executeQuery(
      sql`
        update purchases_orders
           set tracking_number = ${number},
               tracking_added_by_user_id = coalesce(case when tracking_number = ${number} then tracking_added_by_user_id end, ${userId}::uuid),
               shipment_state = coalesce(${state}, shipment_state),
               shipment_checked_at = case when ${state}::text is null then shipment_checked_at else ${now} end,
               expected_arrival = coalesce(${eta}::date, expected_arrival),
               eta_source = case when ${eta}::text is null then eta_source else coalesce(eta_source, 'receipt') end,
               status = case when status in ('planned', 'ordered') then 'in-transit' else status end,
               updated_at = now()
         where id = ${orderId}`.compile(db),
    );
    return {
      mode: "order",
      shipment_id: null,
      tracking_number: number,
      lines: open.map((l) => ({ id: l.id, description: l.description })),
      not_shipped: [],
      vendor: order.vendor,
      order_number: order.order_number,
      expected_arrival: eta ?? dateText(order.expected_arrival),
      created: orderNumber !== number,
    };
  }

  const before = await db
    .selectFrom("purchases_order_shipments")
    .select(["id"])
    .where("order_id", "=", orderId)
    .where("tracking_number", "=", number)
    .executeTakeFirst();
  const row = await db
    .insertInto("purchases_order_shipments")
    .values({
      order_id: orderId,
      tracking_number: number,
      shipment_state: state,
      shipment_checked_at: state ? now : null,
      expected_arrival: eta,
      eta_source: eta ? "receipt" : null,
      description: input.description ?? null,
      tracking_added_by_user_id: userId,
    })
    .onConflict((oc) =>
      oc.columns(["order_id", "tracking_number"]).doUpdateSet({
        shipment_state: sql`coalesce(excluded.shipment_state, purchases_order_shipments.shipment_state)`,
        shipment_checked_at: sql`coalesce(excluded.shipment_checked_at, purchases_order_shipments.shipment_checked_at)`,
        expected_arrival: sql`coalesce(excluded.expected_arrival, purchases_order_shipments.expected_arrival)`,
        description: sql`coalesce(excluded.description, purchases_order_shipments.description)`,
        updated_at: now,
      } as never),
    )
    .returning(["id", "expected_arrival"])
    .executeTakeFirstOrThrow();

  if (picked.length) {
    await db.updateTable("purchases_order_items").set({ shipment_id: row.id }).where("id", "in", picked).where("order_id", "=", orderId).execute();
  }
  if (PRE_SHIP.includes(order.status)) {
    await db.updateTable("purchases_orders").set({ status: "in-transit", updated_at: now } as never).where("id", "=", orderId).execute();
  }

  const after = await db
    .selectFrom("purchases_order_items")
    .select(["id", "description", "shipment_id", "received_at"])
    .where("order_id", "=", orderId)
    .orderBy("created_at")
    .execute();
  // The order's own number covers the lines in no parcel, when it has one.
  const notShipped = after.filter((l) => !l.received_at && !l.shipment_id && !orderNumber);
  return {
    mode: "shipment",
    shipment_id: row.id,
    tracking_number: number,
    lines: after.filter((l) => l.shipment_id === row.id).map((l) => ({ id: l.id, description: l.description })),
    not_shipped: notShipped.map((l) => ({ id: l.id, description: l.description })),
    vendor: order.vendor,
    order_number: order.order_number,
    expected_arrival: dateText(row.expected_arrival),
    created: !before,
  };
}

/** Was this order marked arrived when its receipt was filed, rather than by a
 *  person later? Filing stamps the order's own date (or none); a person's
 *  "it turned up" comes on a later day. */
export function arrivedWhenFiled(o: { arrived_at: Date | string | null; ordered_at: Date | string | null; created_at: Date | string }): boolean {
  const arrived = dateText(o.arrived_at);
  if (!arrived) return true;
  const ordered = dateText(o.ordered_at);
  if (ordered && arrived <= ordered) return true;
  const created = dateText(o.created_at);
  return !!created && arrived <= created;
}

function dateText(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** "Yes, it turned up" for ONE parcel: its lines are received, and the order
 *  arrives only when nothing else on it is still to come. Idempotent. */
export async function receiveShipment(
  db: Kysely<PurchasesDB>,
  orgId: string,
  orderId: string,
  shipmentId: string,
  receivedOn: string = arrivedEverywhere(new Date()),
): Promise<{ received: number; orderArrived: boolean }> {
  const lines = await db
    .selectFrom("purchases_order_items")
    .select(["id", "part_id"])
    .where("order_id", "=", orderId)
    .where("shipment_id", "=", shipmentId)
    .execute();
  let received = 0;
  for (const l of lines) if (await receiveOrderLine(db, orgId, l.id, receivedOn, l.part_id)) received++;
  // The box is in hand: it is not followed or asked about again.
  await db
    .updateTable("purchases_order_shipments")
    .set({ received_at: sql`coalesce(received_at, now())`, updated_at: new Date() } as never)
    .where("id", "=", shipmentId)
    .execute();

  const left = await db
    .selectFrom("purchases_order_items")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("order_id", "=", orderId)
    .where("received_at", "is", null)
    .executeTakeFirstOrThrow();
  if (left.n > 0) return { received, orderArrived: false };

  const order = await db.selectFrom("purchases_orders").select(["status"]).where("id", "=", orderId).executeTakeFirst();
  if (!order || order.status === "arrived") return { received, orderArrived: false };
  await db
    .updateTable("purchases_orders")
    .set({ status: "arrived", arrived_at: receivedOn, updated_at: new Date() } as never)
    .where("id", "=", orderId)
    .execute();
  await platform().events.emit("purchases.order.status_changed", { orgId, orderId, from: order.status, to: "arrived" });
  await platform().events.emit("purchases.order.arrived", { orgId, orderId });
  // Nothing is left to receive; called for the one door's own guarantees.
  await receiveOrderLines(db, orgId, orderId, receivedOn);
  return { received, orderArrived: true };
}

/** An order's parcels, for its page: each with the lines it carries. */
export async function listShipments(db: Kysely<PurchasesDB>, orderId: string) {
  return db
    .selectFrom("purchases_order_shipments")
    .select(["id", "tracking_number", "shipment_state", "shipment_checked_at", "expected_arrival", "description", "created_at"])
    .where("order_id", "=", orderId)
    .orderBy("created_at")
    .execute();
}
