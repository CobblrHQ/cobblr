import { readOrderEmail } from "../order-email.js";
import { mapIntakeOrder, readIntake } from "../intake.js";
// sales action handlers. `sales.fulfill-order` is the userInvokable + wire
// target: take each line item's part out of inventory stock + stamp
// fulfilled, or refuse when stock is short. One implementation with the route
// (fulfilment.ts).

import { type Kysely } from "kysely";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "../db.js";
import { fulfilOrder } from "../fulfilment.js";
import { cancelOrder, reinstateOrder, type Restocked } from "../cancel.js";
import { createOrder } from "../create-order.js";
import { shipOrder } from "../ship.js";
import { makeLine } from "../make-line.js";

import { undoDeliveryClose } from "../close-delivered.js";

let registered = false;

interface FulfillArgs {
  order_id?: string;
  /** "available" ships what is on hand and leaves the rest open. */
  ship?: string;
}

export function registerSalesActionHandlers(): void {
  if (registered) return;
  registered = true;
  platform().actions.registerHandler("sales.undo-delivery-close", async (ctx) => {
    const orderId = ctx.entity?.kind === "sales:order" ? ctx.entity.id : String(ctx.args?.order_id ?? "");
    if (!orderId) return { ok: false, error: "Choose an order to reopen" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    return { ok: true, undone: await undoDeliveryClose(db, ctx.orgId, ctx.userId, orderId) };
  });

  // Cancel, and its way back. A cancel of a shipped order with no answer to
  // "did it come back?" is refused with that question, never guessed.
  platform().actions.registerHandler("sales.cancel-order", async (ctx) => {
    if (ctx.entity?.kind !== "sales:order") return { ok: false, error: "cancel works on a sales order" };
    const raw = (ctx.args as { returned?: unknown } | null)?.returned;
    const returned = raw === true || raw === "true" ? true : raw === false || raw === "false" ? false : undefined;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await cancelOrder(db, ctx.orgId, ctx.userId, ctx.entity.id, { returned });
    if (!r.ok) return r.code === "already_cancelled" ? { ok: true, skipped: r.message } : { ok: false, error: r.message, code: r.code };
    return { ok: true, from: r.from, restocked: r.restocked };
  });
  platform().actions.registerHandler("sales.reinstate-order", async (ctx) => {
    if (ctx.entity?.kind !== "sales:order") return { ok: false, error: "reinstate works on a sales order" };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const restocked = readJsonArg<Restocked[]>(args, "restocked") ?? [];
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await reinstateOrder(db, ctx.orgId, ctx.userId, ctx.entity.id, { from: String(args.from ?? "confirmed") as SalesOrderStatus, restocked });
    return r.ok ? { ok: true, retaken: r.retaken, status: r.status, complete: r.complete } : { ok: false, error: r.message };
  });
  platform().actions.registerUndo("sales.cancel-order", (result, ctx) => {
    const r = result as { ok?: unknown; from?: unknown; restocked?: unknown } | null;
    if (r?.ok !== true || typeof r.from !== "string" || !ctx.entity) return null;
    return { action_id: "sales:reinstate-order", args: { from: r.from, restocked: JSON.stringify(r.restocked ?? []) }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });

  platform().actions.registerHandler("sales.fulfill-order", async (ctx) => {
    const args = (ctx.args as FulfillArgs | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    if (!orderId) return { ok: false, skipped: "no order_id" };

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const result = await fulfilOrder(db, ctx.orgId, ctx.userId, orderId, args.ship === "available" ? "available" : "all");
    if (!result.ok) {
      if (result.code === "already_fulfilled") return { ok: true, skipped: result.message };
      // A shortage refuses with the same sentence the order's page shows.
      return { ok: false, error: result.message, code: result.code, shortages: result.shortages };
    }
    const decremented = result.shipped.map((s) => ({ part_id: s.part_id, qty: s.qty }));
    void platform().events.emit("sales.order.fulfilled", { orgId: ctx.orgId, orderId, decremented, complete: result.complete, viaWire: ctx.event?.trigger_type === "event" });
    return { ok: true, orderId, decremented, complete: result.complete };
  });

  // sales.ship-order: carrier + tracking on the order and status shipped, for
  // a wire or the assistant. It NEVER emails the customer: only a person
  // pressing Ship with "Email the customer" ticked does that (ship.ts).
  platform().actions.registerHandler("sales.ship-order", async (ctx) => {
    const args = (ctx.args as { order_id?: string; tracking_number?: string; carrier?: string } | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    if (!orderId) return { ok: false, skipped: "no order_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await shipOrder(db, ctx.orgId, {
      orderId,
      shop: "",
      userId: ctx.userId,
      trackingNumber: args.tracking_number ?? null,
      carrier: args.carrier ?? null,
      emailCustomer: null,
    });
    if (!r.ok) return { ok: false, error: r.message, code: r.code };
    return { ok: true, orderId, carrier: r.carrier, tracking_number: r.tracking_number, tracking_url: r.lookup?.url ?? null };
  });

  // sales.make-line: "Make this" for an order line, for the assistant or a
  // wire. Plans a builds work order for the line's part (make-line.ts).
  platform().actions.registerHandler("sales.make-line", async (ctx) => {
    const args = (ctx.args as { order_id?: string; line_id?: string; qty?: number } | null) ?? {};
    const orderId = args.order_id?.trim() || (ctx.entity?.kind === "sales:order" ? ctx.entity.id : undefined);
    const qty = Math.floor(Number(args.qty));
    if (!orderId || !args.line_id || !(qty > 0)) return { ok: false, error: "Name the order, the line and how many to make." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await makeLine(db, ctx.orgId, ctx.userId, orderId, args.line_id, qty);
    return r.ok ? r : { ok: false, error: r.message, code: r.code, ...(r.module ? { module: r.module } : {}) };
  });

  platform().actions.registerHandler("sales.read-order-email", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const order = await readOrderEmail(ctx.orgId, ctx.userId ?? null, ctx.args);
    if (!order) return { ok: true, ignored: true, item_count: 0 };
    const setting = await readIntake(db, "sales");
    const result = await createOrder(db, ctx.orgId, ctx.userId ?? null, mapIntakeOrder(order, setting?.mapping ?? {}, await platform().money.currency(ctx.orgId)));
    return { ...result, item_count: result.ok ? order.items.length : 0 };
  });

  platform().actions.registerHandler("sales.create-order", async (ctx) => {
    const raw = (ctx.args ?? {}) as Record<string, unknown>;
    return createOrder((await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>, ctx.orgId, ctx.userId ?? null, {
      ...raw,
      customer: readJsonArg(raw, "customer"),
      items: readJsonArg(raw, "items"),
      metadata: readJsonArg(raw, "metadata"),
      source: readJsonArg(raw, "source"),
    });
  });
}
