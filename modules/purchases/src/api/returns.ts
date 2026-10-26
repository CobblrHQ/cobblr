// Returns on an order: see them, start one, move it along (#4250).
//
//   GET  /orders/:id/returns             the order's returns
//   POST /orders/:id/returns             a step on the order: start a return,
//                                        or a store's email saying where one
//                                        has got to (core-scan's ingest)
//   POST /returns/:returnId/stage        move one return to a stage
//
// Every door runs one step through recordReturnStep (../returns.ts), which
// owns which return a step belongs to, the forward-only stages, and the two
// once-only consequences (the shelf and the spend). This file adds what a
// step tells people: the activity row, the event, and, for a store's email,
// the card to whoever owns the parcel. A person does not get a card about
// the step they just took.

import { REFUND_ALREADY_RECORDED } from "@cobblr/platform-contract/purchase-refund";
import { Router } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ActionRefusal, platform, parcelAudience } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb, type PurchasesDB } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { fieldCurrency, formatStoredMoney } from "@cobblr/platform-contract/money";
import { RETURN_STAGES, RETURN_WORDS, listReturns, recordReturnStep, type ReturnRow, type ReturnSource, type StepOutcome } from "../returns.js";

export const returnsRouter = Router({ mergeParams: true });

const Step = z.object({
  stage: z.enum(RETURN_STAGES).default("requested"),
  return_id: z.string().uuid().nullable().optional(),
  line_id: z.string().uuid().nullable().optional(),
  item: z.string().max(200).nullable().optional(),
  qty: z.number().positive().max(1_000_000).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
  refund_amount: z.number().nonnegative().max(100_000_000).nullable().optional(),
  description: z.string().max(240).nullable().optional(),
  observed_at: z.string().datetime().optional(),
  source: z.enum(["person", "email", "assistant"]).optional(),
});
export type ReturnStepBody = z.infer<typeof Step>;

/** One step, and everything it tells: the shared body of every door. */
export async function takeReturnStep(orgId: string, userId: string | null, orderId: string, body: ReturnStepBody, source: ReturnSource, revert = false): Promise<StepOutcome> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
  const outcome = await recordReturnStep(db, {
    orgId,
    orderId,
    stage: body.stage,
    returnId: body.return_id ?? null,
    lineId: body.line_id ?? null,
    item: body.item ?? null,
    qty: body.qty ?? null,
    reason: body.reason ?? body.description ?? null,
    refundAmount: body.refund_amount ?? null,
    ...(body.observed_at ? { at: body.observed_at } : {}),
    by: userId,
    source,
    revert,
  });

  // A store cancelling something with no return to cancel is cancelling the
  // order (or one item of it) before it shipped: the arrival watch ends when
  // that is the whole order.
  if (!outcome.ret && body.stage === "cancelled" && source === "email") await cancelWholeOrder(db, orderId, body.item ?? null);
  if (!outcome.ret && !(body.stage === "cancelled" && source === "email")) return outcome;

  const ret = outcome.ret;
  if (ret && (outcome.moved || outcome.created)) {
    await platform().activity.log({
      orgId,
      userId,
      action: outcome.created ? "order_return_started" : "order_return_recorded",
      ref: { module: "purchases", entityType: "order", entityId: orderId },
      diff: { return_id: ret.id, item: ret.item, qty: Number(ret.qty), stage: ret.stage, from: outcome.from, refund_amount: ret.refund_amount == null ? null : Number(ret.refund_amount), source },
    });
  }
  await platform().events.emit("purchases.order.return_recorded", { orgId, orderId, stage: ret?.stage ?? body.stage, returnId: ret?.id ?? null });
  if (source === "email" && (outcome.moved || outcome.created || !ret)) await cardTheOwner(db, orgId, orderId, body, ret);
  return outcome;
}

async function cancelWholeOrder(db: Kysely<PurchasesDB>, orderId: string, item: string | null): Promise<void> {
  const lines = await db.selectFrom("purchases_order_items").select(["id", "description"]).where("order_id", "=", orderId).execute();
  const named = (item ?? "").toLowerCase().slice(0, 24);
  const wholeOrder = lines.length <= 1 || (named.length > 3 && lines.length === lines.filter((l) => (l.description ?? "").toLowerCase().includes(named)).length);
  if (wholeOrder) await db.executeQuery(sql`update purchases_orders set status = 'cancelled', updated_at = now() where id = ${orderId} and status <> 'arrived'`.compile(db));
}

// The card. Same audience rule as an arrival: the parcel's owner, else
// everyone. No button: a return needs nothing confirmed, it needs to be known.
async function cardTheOwner(db: Kysely<PurchasesDB>, orgId: string, orderId: string, body: ReturnStepBody, ret: ReturnRow | null): Promise<void> {
  const order = await db.selectFrom("purchases_orders").select(["vendor", "order_number", "tracking_added_by_user_id", "metadata"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return;
  const what = body.item ? body.item : order.vendor ? `your ${order.vendor} order` : "your order";
  const refund = body.refund_amount ?? (ret?.stage === "refunded" && ret.refund_amount != null ? Number(ret.refund_amount) : null);
  const money = refund != null ? ` (${formatStoredMoney(refund, "amount", { currency: fieldCurrency(order.metadata, "total_cost", await platform().money.currency(orgId)) })})` : "";
  const words = body.stage === "cancelled" && !ret ? "cancelled" : RETURN_WORDS[body.stage];
  const memberIds = await platform().notifications.orgMemberIds(orgId);
  const audience = parcelAudience([order.tracking_added_by_user_id], new Set(memberIds));
  const recordLink = await platform().entities.recordAddressForEntity(orgId, "purchases:order", orderId);
  for (const userId of audience) {
    try {
      await platform().notifications.dispatch({
        orgId,
        userId,
        eventType: "purchases.order.return",
        message: `${what}: ${words}${money}.`,
        module: "purchases",
        entityType: "purchases:order",
        entityId: orderId,
        ...(recordLink ? { link_url: recordLink } : { no_link_reason: "the order has no detail page" }),
        card: {
          heading: `${words.replace(/^\w/, (c) => c.toUpperCase())}${money}`,
          body: body.item ?? what,
          ...(order.vendor ? { context: `${order.vendor}${order.order_number ? ` · #${order.order_number}` : ""}` } : {}),
        },
        payload: { stage: body.stage, refund_amount: refund },
      });
    } catch (err) {
      console.error("[purchases] return notify failed:", (err as Error).message);
    }
  }
}

function shape(r: ReturnRow) {
  return {
    id: r.id,
    order_id: r.order_id,
    line_id: r.line_id,
    item: r.item,
    qty: Number(r.qty),
    reason: r.reason,
    stage: r.stage,
    refund_amount: r.refund_amount == null ? null : Number(r.refund_amount),
    refunded_at: r.refunded_at,
    off_shelf: r.stock_returned_at != null,
    history: r.steps,
    created_at: r.created_at,
  };
}

async function orderInScope(req: Parameters<typeof tenantDb>[0], id: string): Promise<boolean> {
  return !!(await tenantDb(req).selectFrom("purchases_orders").select("id").where("id", "=", id).where("instance", "=", instanceOf(req)).executeTakeFirst());
}

returnsRouter.get(
  "/orders/:id/returns",
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    if (!(await orderInScope(req, id))) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    res.json({ items: (await listReturns(tenantDb(req), id)).map(shape) });
  }),
);

// UI-SCREEN: /purchases/:id (the order's Returns section: Start a return; a store's email arrives through core-scan's ingest)
// AI-REACH: action purchases:start-return
returnsRouter.post(
  "/orders/:id/returns",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "purchases:start-return"))) return;
    const id = req.params.id!;
    const parsed = Step.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    if (!(await orderInScope(req, id))) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    try {
      const out = await takeReturnStep(tenantContext(req).org.id, sessionUser(req).id, id, parsed.data, parsed.data.source ?? "person");
      res.status(201).json({ order_id: id, stage: out.ret?.stage ?? parsed.data.stage, return: out.ret ? shape(out.ret) : null, created: out.created });
    } catch (err) {
      if (err instanceof ActionRefusal) return void res.status(422).json({ error: { code: "refused", message: err.message } });
      throw err;
    }
  }),
);

// UI-SCREEN: /purchases/:id (the stage pills on a return in the order's Returns section)
// AI-REACH: action purchases:advance-return
returnsRouter.post(
  "/returns/:returnId/stage",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "purchases:advance-return"))) return;
    const parsed = Step.safeParse({ ...(req.body ?? {}), return_id: req.params.returnId });
    if (!parsed.success) return badBody(res, parsed.error);
    const row = await tenantDb(req).selectFrom("purchases_returns").select(["order_id"]).where("id", "=", req.params.returnId!).executeTakeFirst();
    if (!row || !(await orderInScope(req, row.order_id))) return void res.status(404).json({ error: { code: "not_found", message: "return not found" } });
    try {
      const out = await takeReturnStep(tenantContext(req).org.id, sessionUser(req).id, row.order_id, parsed.data, "person");
      res.json({ return: out.ret ? shape(out.ret) : null, moved: out.moved });
    } catch (err) {
      if (err instanceof ActionRefusal) return void res.status(422).json({ error: { code: "refused", message: err.message } });
      throw err;
    }
  }),
);

/** The assistant's (and any wire's) doors, the same step as the page. */
export function registerReturnActions(): void {
  platform().actions.registerHandler("purchases.start-return", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const orderId = typeof args.order_id === "string" ? args.order_id : ctx.entity?.kind === "purchases:order" ? ctx.entity.id : null;
    if (!orderId) throw new ActionRefusal("Say which order the return is from.");
    const parsed = Step.safeParse({ stage: "requested", line_id: args.line_id ?? null, item: args.item ?? null, qty: args.qty == null ? null : Number(args.qty), reason: args.reason ?? null });
    if (!parsed.success) throw new ActionRefusal("Choose the line and how many to return.");
    const out = await takeReturnStep(ctx.orgId, ctx.userId ?? null, orderId, parsed.data, ctx.event?.actor?.auth_method === "session" ? "person" : "assistant");
    return { ok: true, changed: out.created || out.moved, return_id: out.ret?.id ?? null, stage: out.ret?.stage ?? null, created: out.created, summary: out.created ? `Return started for ${out.ret?.item ?? "the item"}.` : `That item already has a return open.` };
  });
  platform().actions.registerHandler("purchases.advance-return", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const returnId = typeof args.return_id === "string" ? args.return_id : null;
    if (!returnId) throw new ActionRefusal("Say which return to move along.");
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    const row = await db.selectFrom("purchases_returns").select(["order_id"]).where("id", "=", returnId).executeTakeFirst();
    if (!row) throw new ActionRefusal("That return is gone.");
    const parsed = Step.safeParse({ stage: args.stage, return_id: returnId, refund_amount: args.refund_amount == null ? null : Number(args.refund_amount) });
    if (!parsed.success) throw new ActionRefusal("Choose a stage: dropped off, received, refunded or cancelled.");
    const revert = args.revert === true;
    const out = await takeReturnStep(ctx.orgId, ctx.userId ?? null, row.order_id, parsed.data, ctx.event?.actor?.auth_method === "session" ? "person" : "assistant", revert);
    return { ok: true, changed: out.moved, return_id: returnId, stage: out.ret?.stage ?? null, from: out.from, summary: out.moved ? `Return is now ${RETURN_WORDS[out.ret!.stage]}.` : parsed.data.stage === "refunded" && out.ret?.stage === "refunded" ? REFUND_ALREADY_RECORDED : "That return was already further along." };
  });

  // Undo: a started return is cancelled; a stage is taken back to where it
  // was, which puts the stock back and takes the refund off again when the
  // step had done either.
  platform().actions.registerUndo("purchases.start-return", (result) => {
    const r = result as { ok?: unknown; created?: unknown; return_id?: unknown } | null;
    if (r?.ok !== true || !r.created || typeof r.return_id !== "string") return null;
    return { action_id: "purchases:advance-return", args: { return_id: r.return_id, stage: "cancelled" } };
  });
  platform().actions.registerUndo("purchases.advance-return", (result) => {
    const r = result as { ok?: unknown; changed?: unknown; return_id?: unknown; from?: unknown } | null;
    if (r?.ok !== true || !r.changed || typeof r.return_id !== "string" || typeof r.from !== "string") return null;
    return { action_id: "purchases:advance-return", args: { return_id: r.return_id, stage: r.from, revert: true } };
  });
}
