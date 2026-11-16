// Ship an order: the carrier and tracking number it went out with, the order
// marked shipped, its history, and the notice for the customer.
//
// The tracking number is the order's own. core-shipments names the carrier and
// the page to follow it on (core-shipments:identify), and its panel follows the
// parcel on the order; there is no shipment table to keep in step (#4051).
//
// The customer is emailed only when a PERSON ticked "Email the customer" and
// pressed Ship. The route is the only caller that can say so; the action (a
// wire, the assistant) never emails. The mail goes out through the workspace's
// own outbound email (platform().outboundEmail), which logs it; with none set
// up, the person gets the words to copy instead.

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "./db.js";
import { fulfilOrderUnderLock, orderStockComplete, type FulfilDoor, type Shortage } from "./fulfilment.js";
import { withOrderLock } from "./order-lock.js";
import { orderHappened } from "./history.js";
import { everyLineInParcels, recordParcelUnderLock, unparcelled } from "./parcels.js";

export interface Lookup {
  url: string;
  via: string;
  isCarrier: boolean;
}

export interface CustomerNotice {
  to: string | null;
  subject: string;
  text: string;
}

/** Whether the notice can be emailed, and if not, the reason a person reads. */
export interface EmailAvailability {
  available: boolean;
  from: string | null;
  reason: string | null;
}

async function identify(orgId: string, number: string): Promise<{ carrier: string | null; lookup: Lookup | null }> {
  if (!number) return { carrier: null, lookup: null };
  const r = (await platform()
    .actions.invoke("core-shipments:identify", {
      orgId,
      userId: null,
      scope: "workspace",
      event: {
        name: null,
        payload: {},
        actor: { user_id: null, display_name: null, auth_method: "session" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      args: { number },
    })
    .catch(() => null)) as { carrier?: { name?: string } | null; lookup?: Lookup } | null;
  return { carrier: r?.carrier?.name ?? null, lookup: r?.lookup ?? null };
}

async function customerOf(db: Kysely<SalesDB>, customerId: string | null): Promise<{ name: string | null; email: string | null }> {
  if (!customerId) return { name: null, email: null };
  const c = await db.selectFrom("sales_customers").select(["name", "email"]).where("id", "=", customerId).executeTakeFirst();
  return { name: c?.name ?? null, email: c?.email?.trim() || null };
}

/** The words the customer reads. Plain, and complete without the link. */
export function noticeText(p: {
  shop: string;
  customerName: string | null;
  orderNumber: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  lookup: Lookup | null;
  /** What is in this box when it is not the whole order ("2 Ceramic mug"). */
  part?: string | null;
}): { subject: string; text: string } {
  const order = p.orderNumber ? `order ${p.orderNumber}` : "order";
  const subject = p.part
    ? (p.shop ? `Part of your ${order} from ${p.shop} has shipped` : `Part of your ${order} has shipped`)
    : (p.shop ? `Your ${order} from ${p.shop} has shipped` : `Your ${order} has shipped`);
  const lines = [
    p.customerName ? `Hi ${p.customerName},` : "Hi,",
    "",
    p.part
      ? `Part of your ${order} is on its way${p.carrier ? ` with ${p.carrier}` : ""}: ${p.part}.`
      : `Your ${order} is on its way${p.carrier ? ` with ${p.carrier}` : ""}.`,
  ];
  if (p.trackingNumber) lines.push(`Tracking number: ${p.trackingNumber}`);
  if (p.lookup) lines.push(`Follow it here: ${p.lookup.url}`);
  lines.push("", p.shop ? `Thank you,\n${p.shop}` : "Thank you.");
  return { subject, text: lines.join("\n") };
}

async function emailAvailability(orgId: string, to: string | null): Promise<EmailAvailability> {
  const s = await platform().outboundEmail.status(orgId);
  if (!s.configured) return { available: false, from: null, reason: "This workspace has no outbound email set up (Configuration → Email)." };
  if (!to) return { available: false, from: s.from, reason: "The customer has no email address on file." };
  return { available: true, from: s.from, reason: null };
}

/** What Ship will say and whether it can email, before anything moves. */
export async function shipPreview(
  db: Kysely<SalesDB>,
  orgId: string,
  shop: string,
  orderId: string,
  trackingNumber: string,
): Promise<{ notice: CustomerNotice; email: EmailAvailability; carrier: string | null; lookup: Lookup | null } | null> {
  const order = await db.selectFrom("sales_orders").selectAll().where("id", "=", orderId).executeTakeFirst();
  if (!order) return null;
  const customer = await customerOf(db, order.customer_id);
  const { carrier, lookup } = await identify(orgId, trackingNumber);
  const words = noticeText({
    shop,
    customerName: customer.name ?? order.customer_name,
    orderNumber: order.order_number,
    carrier,
    trackingNumber: trackingNumber || null,
    lookup,
  });
  return { notice: { to: customer.email, ...words }, email: await emailAvailability(orgId, customer.email), carrier, lookup };
}

export type ShipResult =
  | {
      ok: true;
      status: SalesOrderStatus;
      /** False when this went out as a parcel and the order is still open: some lines are not in stock yet (#9505). */
      shipped: boolean;
      parcel_id: string | null;
      carrier: string | null;
      tracking_number: string | null;
      lookup: Lookup | null;
      notice: CustomerNotice;
      /** What happened to the email: not asked for, sent, or why it did not go. */
      email: { asked: false } | { asked: true; sent: true; to: string; status: "sent" | "skipped" } | { asked: true; sent: false; reason: string };
    }
  | { ok: false; code: string; message: string; shortages: Shortage[]; doors: FulfilDoor[] };

type EmailOutcome = Extract<ShipResult, { ok: true }>["email"];

/** Tell the customer about one parcel, only when a person asked (the route says so). Never throws: the outcome says what happened. */
export async function notifyParcel(
  db: Kysely<SalesDB>,
  orgId: string,
  orderId: string,
  p: { shop: string; carrier: string | null; trackingNumber: string | null; lookup: Lookup | null; part: string | null; pressedBy: string | null },
): Promise<{ notice: CustomerNotice; email: EmailOutcome }> {
  const order = await db.selectFrom("sales_orders").selectAll().where("id", "=", orderId).executeTakeFirstOrThrow();
  const customer = await customerOf(db, order.customer_id);
  const words = noticeText({
    shop: p.shop,
    customerName: customer.name ?? order.customer_name,
    orderNumber: order.order_number,
    carrier: p.carrier,
    trackingNumber: p.trackingNumber,
    lookup: p.lookup,
    part: p.part,
  });
  const notice: CustomerNotice = { to: customer.email, ...words };
  if (!p.pressedBy) return { notice, email: { asked: false } };
  const can = await emailAvailability(orgId, customer.email);
  if (!can.available || !customer.email) {
    return { notice, email: { asked: true, sent: false, reason: can.reason ?? "The customer has no email address on file." } };
  }
  const sent = await platform().outboundEmail.send(orgId, {
    to: customer.email,
    subject: words.subject,
    text: words.text,
    sentBy: p.pressedBy,
    source: { kind: "sales:order", id: order.id },
  });
  if (sent.ok) {
    await orderHappened(db, orgId, order.id, {
      kind: "email",
      detail: { to: customer.email, subject: words.subject, message_id: sent.messageId, log_id: sent.logId, status: sent.status },
      by_user: p.pressedBy,
    });
    return { notice, email: { asked: true, sent: true, to: customer.email, status: sent.status } };
  }
  await orderHappened(db, orgId, order.id, {
    kind: "email",
    detail: { to: customer.email, subject: words.subject, log_id: sent.logId, status: "failed", error: sent.message },
    by_user: p.pressedBy,
  });
  return { notice, email: { asked: true, sent: false, reason: sent.message } };
}

/** "2 Ceramic mug, 1 Tea tin" for a parcel that is not the whole order; null for the last box (the notice then reads as a whole order). */
const partOf = (lines: Array<{ description: string | null; qty: number }>) => lines.map((l) => `${l.qty} ${l.description ?? "item"}`).join(", ");

/**
 * Ship an order. An order not yet fulfilled is fulfilled first, in full or, when
 * stock is short, as far as the stock goes: what left is recorded as a parcel
 * with the tracking number given, and the order stays open until every line is
 * in a parcel (#9505). Nothing on hand and nothing taken out is refused naming
 * what is short, with the same sentence and doors as Fulfill.
 *
 * `emailCustomer` is honoured only with `pressedBy`, the member who pressed
 * Ship with the box ticked. Everything else ships without mailing anybody.
 */
export async function shipOrder(
  db: Kysely<SalesDB>,
  orgId: string,
  args: {
    orderId: string;
    shop: string;
    userId: string | null;
    trackingNumber?: string | null;
    carrier?: string | null;
    emailCustomer?: { pressedBy: string } | null;
  },
): Promise<ShipResult> {
  return withOrderLock(db, orgId, args.userId, args.orderId, async () => {
    const order = await db.selectFrom("sales_orders").selectAll().where("id", "=", args.orderId).executeTakeFirst();
    if (!order) return { ok: false, code: "not_found", message: "That order is not here any more.", shortages: [], doors: [] };
    if (order.status === "shipped" || order.status === "closed") {
      return { ok: false, code: "already_shipped", message: `This order is already ${order.status}.`, shortages: [], doors: [] };
    }
    if (order.status === "cancelled") {
      return { ok: false, code: "cancelled", message: "A cancelled order does not ship.", shortages: [], doors: [] };
    }
    if (order.status !== "fulfilled") {
      const f = await fulfilOrderUnderLock(db, orgId, args.userId, order.id, "all", false);
      if (!f.ok) {
        if (f.code !== "not_enough_stock" && f.code !== "nothing_to_ship") return { ok: false, code: f.code, message: f.message, shortages: f.shortages, doors: f.doors };
        // Stock is short: send what is on hand (and what was taken out earlier and is not in a box yet) as a parcel; the order stays open.
        const part = await fulfilOrderUnderLock(db, orgId, args.userId, order.id, "available", false);
        if (!part.ok && (await unparcelled(db, order.id)).length === 0) {
          return { ok: false, code: f.code, message: f.message, shortages: f.shortages, doors: f.doors };
        }
      }
    }

    const tracking = args.trackingNumber?.trim() || null;
    const found = await identify(orgId, tracking ?? "");
    const carrier = args.carrier?.trim() || found.carrier;

    const recorded = await recordParcelUnderLock(db, orgId, order.id, { trackingNumber: tracking, carrier, userId: args.userId });
    let shipped: boolean;
    let status: SalesOrderStatus;
    let parcelId: string | null = null;
    let lines: Array<{ description: string | null; qty: number }> = [];
    if (recorded.ok) {
      shipped = recorded.shipped;
      status = recorded.status;
      parcelId = recorded.parcel_id;
      lines = recorded.lines;
    } else if (recorded.code === "nothing_to_put_in_a_parcel" && (await everyLineInParcels(db, order.id)) && (await orderStockComplete(db, order.id))) {
      // An order with nothing stocked on it has no box to describe: it ships as it always did.
      await db
        .updateTable("sales_orders")
        .set({ status: "shipped", carrier, tracking_number: tracking, shipped_at: new Date(), updated_at: new Date() })
        .where("id", "=", order.id)
        .execute();
      await orderHappened(db, orgId, order.id, { kind: "shipped", detail: { carrier, tracking_number: tracking }, by_user: args.userId });
      await orderHappened(db, orgId, order.id, { kind: "status", from_status: "fulfilled", to_status: "shipped", by_user: args.userId });
      void platform().events.emit("sales.order.shipped", { orgId, orderId: order.id, carrier, trackingNumber: tracking });
      shipped = true;
      status = "shipped";
    } else {
      return { ok: false, code: recorded.code, message: recorded.message, shortages: [], doors: [] };
    }

    const told = await notifyParcel(db, orgId, order.id, {
      shop: args.shop,
      carrier,
      trackingNumber: tracking,
      lookup: found.lookup,
      part: shipped ? null : partOf(lines),
      pressedBy: args.emailCustomer?.pressedBy ?? null,
    });
    return { ok: true, status, shipped, parcel_id: parcelId, carrier, tracking_number: tracking, lookup: found.lookup, notice: told.notice, email: told.email };
  });
}
