// POST /scan/receipt/shipment-event — a shipping notification, applied.
//
// The email ingest reads a forwarded "Shipped:" / "Arriving today:" /
// "Delivered:" as a carrier event (services/shipment-email.ts) and hands it
// here. This route finds the parcel the email is about, writes the state the
// email announces exactly as a carrier poll would have, and announces it NOW
// through the same rule the hourly sweep uses — so a delivery is a Discord
// card within seconds of the store's email, with nobody touching anything.
//
// Three ways to find the parcel, in order of certainty: the tracking number
// the email carries; the store + order number (Amazon's 3-7-7, or "Order #X");
// and when neither matches anything, the parcel is NEW — a shipping notice that
// arrived before its receipt. That becomes a row-less session in read_state
// 'awaiting', followed from now on, and the order confirmation reads INTO it
// when it is forwarded (the receipt route's awaiting-reuse).
//
// The event carries no line items on purpose. Amazon stripped them from its
// emails; the parser owns the ones that do have them.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, sessionUser, bearer } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { receiptSessionLabel, cleanOrderRef, sameOrder, cancellationEndsSession } from "../services/receipt-shared.js";
import { receiptTrackingTick } from "../services/receipt-tracking-sweeper.js";
import { INTERNAL_API } from "./inbox.js";
import { formatStoredMoney } from "@cobblr/platform-contract/money";

export const shipmentEventRouter = Router({ mergeParams: true });

const Body = z.object({
  /** "ordered" is not a carrier state: it is the order confirmation whose
   *  lines the parser could not read. It makes the parcel EXIST (an awaiting
   *  session) and records a promised day; it stamps no carrier state. */
  state: z.enum(["ordered", "in_transit", "out_for_delivery", "delivered", "exception"]),
  vendor: z.string().max(120).nullable().optional(),
  order_ref: z.string().max(64).nullable().optional(),
  tracking_number: z.string().max(64).nullable().optional(),
  description: z.string().max(240).nullable().optional(),
  expected_arrival: z.enum(["today", "tomorrow"]).nullable().optional(),
  /** The promised day as a date, when the email names one. */
  expected_arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** When the email was sent, for the record; defaults to now. */
  observed_at: z.string().datetime().optional(),
});

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// AI-REACH: exempt (the inbound-email ingest's own door — a store's email is
// the caller. The assistant reaches parcel state through the shipments
// capability and the receipt's tracking route, which is where a person would
// type it.)
// UI-REACH: the email ingest's own door; a store's email is the caller
shipmentEventRouter.post(
  "/scan/receipt/shipment-event",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ev = parsed.data;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const now = new Date();

    const tracking = ev.tracking_number ? ev.tracking_number.replace(/\s+/g, "") : null;
    const orderRef = cleanOrderRef(ev.order_ref ?? null);
    const vendor = ev.vendor?.trim() || null;

    // 1. By tracking number: the most certain match, and the only one a
    //    carrier's own email (which names no store) can make.
    let batch: { id: string; purchases_order_id: string | null; tracking_number: string | null; shipment_state: string | null } | undefined;
    if (tracking) {
      batch = await db
        .selectFrom("core_scan_batches")
        .select(["id", "purchases_order_id", "tracking_number", "shipment_state"])
        .where("tracking_number", "=", tracking)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
    }
    // 2. By store + order number, the way the receipt route dedups.
    if (!batch && orderRef && vendor) {
      batch = sameOrder(
        await db
          .selectFrom("core_scan_batches")
          .select(["id", "vendor", "purchases_order_id", "tracking_number", "shipment_state"])
          .where("order_ref", "=", orderRef)
          .orderBy("created_at", "desc")
          .limit(10)
          .execute(),
        vendor,
        orderRef,
      );
    }

    let created = false;
    if (!batch) {
      // Nothing to hang it on. A carrier notice names no store, and a store
      // notice with NO order number ("Delivered: 2 Electronics items" whose
      // link we could not read) would open a session keyed on nothing — and
      // the next such email another, and the next. Say so instead; the email
      // is archived and the work-list shows it unmatched.
      if (!vendor || !orderRef) {
        res.status(200).json({ applied: false, reason: !vendor ? "no_store_named" : "no_order_number" });
        return;
      }
      // 3. Shipping notice before the receipt. The parcel exists; its lines
      //    do not yet. read_state 'awaiting' puts it on the inbox page and in
      //    the sweep the same way a failed read is there: as a session with
      //    no rows, rather than a fake item.
      const inserted = await db
        .insertInto("core_scan_batches")
        .values({
          created_by_user_id: session.id,
          label: receiptSessionLabel(vendor, orderRef),
          origin: "email",
          vendor,
          order_ref: orderRef,
          read_state: "awaiting",
          ...(tracking ? { tracking_number: tracking, tracking_added_by_user_id: session.id } : {}),
        } as never)
        .returning(["id", "purchases_order_id", "tracking_number", "shipment_state"])
        .executeTakeFirstOrThrow();
      batch = inserted;
      created = true;
    }

    // A number the email carries and the record lacks is the handover from
    // "the emails are the carrier" to "the carrier is the carrier": from here
    // the cadence polls it for real. Whoever forwarded the email owns the
    // parcel, same as typing the number would.
    const gainedTracking = Boolean(tracking && !batch.tracking_number);

    // Delivered is terminal for an email-driven parcel; a later "shipped"
    // recap (a return label, a second box under one order) must not walk a
    // delivered parcel backwards. Anything else moves forward freely. An
    // order notice carries no carrier state at all: it leaves whatever the
    // parcel already says alone.
    const regress = batch.shipment_state === "delivered" && ev.state !== "delivered";
    const state = ev.state === "ordered" ? batch.shipment_state : regress ? "delivered" : ev.state;

    if (ev.state !== "ordered") {
      await db
        .updateTable("core_scan_batches")
        .set({
          shipment_state: state,
          shipment_description: ev.description ?? null,
          shipment_checked_at: ev.observed_at ? new Date(ev.observed_at) : now,
          ...(gainedTracking ? { tracking_number: tracking, tracking_added_by_user_id: session.id } : {}),
        } as never)
        .where("id", "=", batch.id)
        .execute();
    }

    // The receipt's promised date lives on its lines; an awaiting session has
    // none, so "arriving today" goes on the session where the sweep's
    // arrival-day rule reads it through the same max() as the lines.
    const promised = (() => {
      if (ev.expected_arrival_date) return ev.expected_arrival_date;
      if (!ev.expected_arrival) return null;
      const when = new Date(now);
      if (ev.expected_arrival === "tomorrow") when.setDate(when.getDate() + 1);
      return isoDate(when);
    })();
    if (promised) {
      // A later email's day replaces an earlier one: the store's newest
      // estimate is the estimate.
      await db.executeQuery(
        sql`update core_scan_batches set expected_arrival = ${promised} where id = ${batch.id}`.compile(db),
      );
    }

    // The order, if the receipt already made one, hears the same thing —
    // through its own door (module isolation), the way the tracking PATCH
    // already does. The purchases sweep announces order-owned parcels.
    if (batch.purchases_order_id) {
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      try {
        await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/orders/${batch.purchases_order_id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
          // jsonb-replace-ok: an HTTP request body, not a jsonb column.
          body: JSON.stringify({
            ...(ev.state !== "ordered" && state ? { shipment_state: state, shipment_checked_at: now.toISOString() } : {}),
            ...(promised ? { expected_arrival: promised, eta_source: "receipt" } : {}),
            ...(gainedTracking ? { tracking_number: tracking, status: "in-transit", arrived_at: null } : {}),
          }),
        });
      } catch (err) {
        console.warn("[core-scan] shipment event did not reach the order:", (err as Error).message);
      }
      // So purchases can announce THIS order now rather than at its next tick.
      void platform().events.emit("core-scan.shipment.observed", {
        orgId: ctx.org.id,
        orderId: batch.purchases_order_id,
        batchId: batch.id,
        state,
      });
    }

    // Announce now. The sweep decides against everything known and never
    // repeats itself (announceFor), so this is the hourly tick for one parcel,
    // not a second notifier.
    let notified = 0;
    try {
      const r = await receiptTrackingTick({ orgId: ctx.org.id, batchId: batch.id, force: true, now });
      notified = r.notified;
    } catch (err) {
      console.warn("[core-scan] shipment event announce failed:", (err as Error).message);
    }

    res.status(created ? 201 : 200).json({
      applied: true,
      batch_id: batch.id,
      created,
      state,
      regressed: regress,
      gained_tracking: gainedTracking,
      notified,
    });
  }),
);

// ── returns ────────────────────────────────────────────────────────────────
//
// A return notice names an item and (in a link) an order. The order is the
// thing it is ABOUT, and purchases owns orders, so a matched return is handed
// to purchases' own returns door and recorded there. One with no order we can
// find still reaches the person as a card — "dropoff confirmed for X" is
// worth knowing even unattached — rather than vanishing or, worse, being read
// as a receipt for something on its way OUT.

const ReturnBody = z.object({
  stage: z.enum(["requested", "dropped_off", "received", "refunded", "cancelled"]),
  vendor: z.string().max(120).nullable().optional(),
  order_ref: z.string().max(64).nullable().optional(),
  item: z.string().max(200).nullable().optional(),
  refund_amount: z.number().nonnegative().nullable().optional(),
  description: z.string().max(240).nullable().optional(),
});

const RETURN_WORDS = {
  requested: "return started",
  dropped_off: "return dropped off",
  received: "return received by the store",
  refunded: "refund issued",
  cancelled: "cancelled",
} as const;

// AI-REACH: exempt (the email ingest's door; see shipment-event above).
// UI-REACH: the email ingest's own door; a store's email is the caller
shipmentEventRouter.post(
  "/scan/receipt/return-event",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ReturnBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ev = parsed.data;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const orderRef = cleanOrderRef(ev.order_ref ?? null);
    const vendor = ev.vendor?.trim() || null;

    // The order, through the receipt that made it.
    let orderId: string | null = null;
    if (orderRef && vendor) {
      const b = sameOrder(
        await db
          .selectFrom("core_scan_batches")
          .select(["vendor", "purchases_order_id"])
          .where("order_ref", "=", orderRef)
          .where("purchases_order_id", "is not", null)
          .orderBy("created_at", "desc")
          .limit(10)
          .execute(),
        vendor,
        orderRef,
      );
      orderId = b?.purchases_order_id ?? null;
    }

    if (orderId) {
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      try {
        const r = await fetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/purchases/orders/${orderId}/returns`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
          // jsonb-replace-ok: an HTTP request body, not a jsonb column.
          body: JSON.stringify({ stage: ev.stage, item: ev.item ?? null, refund_amount: ev.refund_amount ?? null, description: ev.description ?? null }),
        });
        if (r.ok) {
          res.status(200).json({ applied: true, order_id: orderId, stage: ev.stage, recorded: "order" });
          return;
        }
        console.warn(`[core-scan] return did not reach the order: HTTP ${r.status}`);
      } catch (err) {
        console.warn("[core-scan] return did not reach the order:", (err as Error).message);
      }
    }

    // A cancellation with no order may still name a session that was opened
    // from the order notice and is waiting for a receipt that now never comes.
    // It ends (cancellationEndsSession says when), so the page does not carry
    // "awaiting the receipt" for a parcel the store withdrew.
    let closedSession: string | null = null;
    if (ev.stage === "cancelled" && orderRef) {
      const waiting = sameOrder(
        await db
          .selectFrom("core_scan_batches")
          .select(["id", "vendor", "shipment_state", "shipment_description"])
          .where("read_state", "=", "awaiting")
          .where("order_ref", "=", orderRef)
          .orderBy("created_at", "desc")
          .limit(10)
          .execute(),
        vendor,
        orderRef,
      );
      if (waiting && cancellationEndsSession(waiting)) {
        await db.deleteFrom("core_scan_batches").where("id", "=", waiting.id).where("read_state", "=", "awaiting").execute();
        closedSession = waiting.id;
      }
    }

    // No order to hang it on (or purchases is not enabled): the person still
    // hears it. The card is the same shape purchases sends, minus the link
    // to an order that does not exist.
    const what = ev.item ?? (vendor ? `your ${vendor} order` : "an order");
    const money = ev.refund_amount != null ? ` (${formatStoredMoney(ev.refund_amount, "amount")})` : "";
    try {
      await platform().notifications.dispatch({
        orgId: ctx.org.id,
        userId: session.id,
        eventType: "core-scan.return.update",
        message: `${what}: ${RETURN_WORDS[ev.stage]}${money}.`,
        module: "core-scan",
        // PAGE-LINK: this branch IS the no-record case (the return named no order we could find)
        link_url: `/scan`,
        card: {
          heading: `${RETURN_WORDS[ev.stage].replace(/^\w/, (c) => c.toUpperCase())}${money}`,
          body: what,
          ...(vendor ? { context: `${vendor}${orderRef ? ` · #${orderRef}` : ""}` } : {}),
        },
        payload: { stage: ev.stage, refund_amount: ev.refund_amount ?? null, order_ref: orderRef },
      });
    } catch (err) {
      console.error("[core-scan] return notify failed:", (err as Error).message);
    }
    res.status(200).json({ applied: true, order_id: null, stage: ev.stage, recorded: "notification", closed_session: closedSession });
  }),
);
