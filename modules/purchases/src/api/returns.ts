// POST /orders/:id/returns — a return, recorded on the order it came from.
//
// A return is the reverse of a delivery and has its own lifecycle: requested,
// dropped off, received, refunded. The store emails each step (Amazon from
// return@), and core-scan's email ingest reads them; this is where they land.
// Appended SERVER-SIDE into metadata.returns[], because the order PATCH
// replaces `metadata` whole, and a caller writing one key there would wipe
// receipt_group_id and everything else the order remembers.
//
// The person who owns the parcel hears each step as a card: a return is
// money on its way, and "refund issued" is the one line most people want to
// see without opening anything.

import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform, parcelAudience } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { fieldCurrency, formatStoredMoney } from "@cobblr/platform-contract/money";

export const returnsRouter = Router({ mergeParams: true });

const ReturnEvent = z.object({
  stage: z.enum(["requested", "dropped_off", "received", "refunded", "cancelled"]),
  item: z.string().max(200).nullable().optional(),
  refund_amount: z.number().nonnegative().nullable().optional(),
  description: z.string().max(240).nullable().optional(),
  observed_at: z.string().datetime().optional(),
});

export const RETURN_WORDS: Record<z.infer<typeof ReturnEvent>["stage"], string> = {
  requested: "return started",
  dropped_off: "return dropped off",
  received: "return received by the store",
  refunded: "refund issued",
  cancelled: "cancelled",
};

// AI-REACH: exempt (written by the email ingest from a store's own return
// notices; a person records a return by editing the order, and the assistant
// reaches that through the order CRUD.)
returnsRouter.post(
  "/orders/:id/returns",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = ReturnEvent.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const ev = parsed.data;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const at = ev.observed_at ?? new Date().toISOString();

    const order = await db
      .selectFrom("purchases_orders")
      .select(["id", "vendor", "order_number", "tracking_added_by_user_id", "metadata"])
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!order) {
      res.status(404).json({ error: { code: "not_found", message: "order not found" } });
      return;
    }

    // Append in place. jsonb_set on a path that may not exist yet needs the
    // coalesce; '[]' seeds the list the first time.
    const entry = { stage: ev.stage, item: ev.item ?? null, refund_amount: ev.refund_amount ?? null, description: ev.description ?? null, at };
    await db.executeQuery(
      sql`
        update purchases_orders
           set metadata = jsonb_set(
                 jsonb_set(coalesce(metadata, '{}'::jsonb), '{returns}', coalesce(metadata->'returns', '[]'::jsonb) || ${JSON.stringify(entry)}::jsonb),
                 '{return_stage}', to_jsonb(${ev.stage}::text)
               ),
               updated_at = now()
         where id = ${id}
      `.compile(db),
    );

    // A cancellation before anything shipped ends the order's arrival watch:
    // the sweep skips 'cancelled', and nothing is coming. Only when it is the
    // whole order — one line, or the item named IS that line — because a
    // cancelled item on a three-item order still has two parcels coming.
    if (ev.stage === "cancelled") {
      const lines = await db
        .selectFrom("purchases_order_items")
        .select(["id", "description"])
        .where("order_id", "=", id)
        .execute();
      const named = (ev.item ?? "").toLowerCase().slice(0, 24);
      const wholeOrder =
        lines.length <= 1 ||
        (named.length > 3 && lines.length === lines.filter((l) => (l.description ?? "").toLowerCase().includes(named)).length);
      if (wholeOrder) {
        await db.executeQuery(sql`update purchases_orders set status = 'cancelled', updated_at = now() where id = ${id} and status <> 'arrived'`.compile(db));
      }
    }

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "order_return_recorded",
      ref: { module: "purchases", entityType: "order", entityId: id },
      diff: entry,
    });
    void platform().events.emit("purchases.order.return_recorded", { orgId: ctx.org.id, orderId: id, stage: ev.stage });

    // The card. Same audience rule as an arrival: the parcel's owner, else
    // everyone. No button — a return needs nothing confirmed, it needs to be
    // known about.
    const what = ev.item ? ev.item : order.vendor ? `your ${order.vendor} order` : "your order";
    const money = ev.refund_amount != null ? ` (${formatStoredMoney(ev.refund_amount, "amount", { currency: fieldCurrency(order.metadata, "total_cost", await platform().money.currency(ctx.org.id)) })})` : "";
    const message = `${what}: ${RETURN_WORDS[ev.stage]}${money}.`;
    const memberIds = await platform().notifications.orgMemberIds(ctx.org.id);
    const audience = parcelAudience([order.tracking_added_by_user_id, session.id], new Set(memberIds));
    const recordLink = await platform().entities.recordAddressForEntity(
      ctx.org.id,
      "purchases:order",
      id,
    );
    let notified = 0;
    for (const userId of audience) {
      try {
        await platform().notifications.dispatch({
          orgId: ctx.org.id,
          userId,
          eventType: "purchases.order.return",
          message,
          module: "purchases",
          entityType: "purchases:order",
          entityId: id,
          ...(recordLink
            ? { link_url: recordLink }
            : { no_link_reason: "the order has no detail page" }),
          card: {
            heading: `${RETURN_WORDS[ev.stage].replace(/^\w/, (c) => c.toUpperCase())}${money}`,
            body: ev.item ?? what,
            ...(order.vendor ? { context: `${order.vendor}${order.order_number ? ` · #${order.order_number}` : ""}` } : {}),
          },
          payload: { stage: ev.stage, refund_amount: ev.refund_amount ?? null },
        });
        notified += 1;
      } catch (err) {
        console.error("[purchases] return notify failed:", (err as Error).message);
      }
    }

    res.status(201).json({ order_id: id, stage: ev.stage, notified });
  }),
);
