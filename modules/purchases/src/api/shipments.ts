// The parcels an order ships in (#5351): see them, add one.
//
//   GET  /orders/:id/shipments    the order's parcels and the lines in each
//   POST /orders/:id/shipments    a parcel: its tracking number and the lines
//                                 it carries (by id, or in the store's words,
//                                 which ../shipments.ts matches to lines)
//
// A store's shipping notice arrives here through core-scan's ingest; a person
// adds one from the order's page; the assistant through purchases:add-shipment.
// All three run recordShipment.

import { Router } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import type { Kysely } from "kysely";
import { z } from "zod";
import { ActionRefusal, platform, readJsonArg, readListArg } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb, type PurchasesDB } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { listShipments, recordShipment, type ShipmentOutcome } from "../shipments.js";

export const shipmentsRouter = Router({ mergeParams: true });

const STATES = ["pre_transit", "in_transit", "out_for_delivery", "delivered", "exception", "unknown"] as const;

const ShipmentBody = z.object({
  tracking_number: z.string().trim().min(4).max(64),
  items: z.array(z.object({ description: z.string().max(500), qty: z.number().nullable().optional() })).max(50).optional(),
  line_ids: z.array(z.string().uuid()).max(200).optional(),
  shipment_state: z.enum(STATES).nullable().optional(),
  expected_arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  description: z.string().max(240).nullable().optional(),
});

async function orderInScope(req: Parameters<typeof tenantDb>[0], id: string): Promise<boolean> {
  return !!(await tenantDb(req).selectFrom("purchases_orders").select("id").where("id", "=", id).where("instance", "=", instanceOf(req)).executeTakeFirst());
}

/** One parcel, and what it tells: the activity row and the event. */
export async function addShipment(orgId: string, userId: string | null, orderId: string, body: z.infer<typeof ShipmentBody>): Promise<ShipmentOutcome | null> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<PurchasesDB>;
  const out = await recordShipment(db, orgId, userId, orderId, body);
  if (!out) return null;
  if (out.created) {
    await platform().activity.log({
      orgId,
      userId,
      action: "order_shipment_added",
      ref: { module: "purchases", entityType: "order", entityId: orderId },
      diff: { tracking_number: out.tracking_number, lines: out.lines.map((l) => l.description), whole_order: out.mode === "order" },
    });
  }
  await platform().events.emit("purchases.order.shipment_recorded", { orgId, orderId, shipmentId: out.shipment_id, tracking_number: out.tracking_number });
  return out;
}

shipmentsRouter.get(
  "/orders/:id/shipments",
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    if (!(await orderInScope(req, id))) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    const db = tenantDb(req);
    const parcels = await listShipments(db, id);
    const lines = await db.selectFrom("purchases_order_items").select(["id", "description", "shipment_id", "received_at"]).where("order_id", "=", id).execute();
    res.json({
      items: parcels.map((p) => ({ ...p, lines: lines.filter((l) => l.shipment_id === p.id).map((l) => ({ id: l.id, description: l.description, received: !!l.received_at })) })),
    });
  }),
);

// UI-SCREEN: /purchases/:id (a line's "Shipped in" chip and Add a parcel; a store's notice arrives through core-scan's ingest)
// AI-REACH: action purchases:add-shipment
shipmentsRouter.post(
  "/orders/:id/shipments",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "purchases:add-shipment"))) return;
    const id = req.params.id!;
    const parsed = ShipmentBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    if (!(await orderInScope(req, id))) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    const out = await addShipment(tenantContext(req).org.id, sessionUser(req).id, id, parsed.data);
    if (!out) return void res.status(404).json({ error: { code: "not_found", message: "order not found" } });
    res.status(out.created ? 201 : 200).json(out);
  }),
);

/** What is in the box, as the store worded it: a list of names, or of
 *  { description, qty }. */
function itemsArg(raw: unknown): Array<{ description: string; qty?: number | null }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (typeof x === "string" ? { description: x } : x && typeof x === "object" && typeof (x as { description?: unknown }).description === "string" ? { description: (x as { description: string }).description, qty: Number((x as { qty?: unknown }).qty) || null } : null))
    .filter((x): x is { description: string; qty: number | null } => !!x && !!x.description.trim());
}

/** The assistant's door, the same parcel as the page. */
export function registerShipmentActions(): void {
  platform().actions.registerHandler("purchases.add-shipment", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const orderId = typeof args.order_id === "string" ? args.order_id : ctx.entity?.kind === "purchases:order" ? ctx.entity.id : null;
    if (!orderId) throw new ActionRefusal("Say which order the parcel is for.");
    const parsed = ShipmentBody.safeParse({
      tracking_number: args.tracking_number,
      line_ids: readListArg(args, "line_ids"),
      items: itemsArg(readJsonArg(args, "items")),
      expected_arrival: typeof args.expected_arrival === "string" && args.expected_arrival ? args.expected_arrival : null,
    });
    if (!parsed.success) throw new ActionRefusal("Give the parcel's tracking number, and which lines are in it.");
    const out = await addShipment(ctx.orgId, ctx.userId ?? null, orderId, parsed.data);
    if (!out) throw new ActionRefusal("That order is gone.");
    const what = out.mode === "order" ? "the whole order" : out.lines.length ? out.lines.map((l) => l.description ?? "a line").join(", ") : "no lines it could name";
    return { ok: true, changed: out.created, shipment_id: out.shipment_id, mode: out.mode, summary: `Tracking ${out.tracking_number} added for ${what}.` };
  });
}
