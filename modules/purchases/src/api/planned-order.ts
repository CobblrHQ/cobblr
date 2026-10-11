import { createHash } from "node:crypto";
import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import type { PurchasesDB } from "../db.js";
import { fieldDay } from "@cobblr/platform-contract/field-day";

const PlanOrder = z.object({
  request_key: z.string().trim().min(1).max(200), vendor: z.string().trim().min(1).max(160),
  expected_arrival: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), tracking_number: z.string().max(160).optional(),
  source_file_id: z.string().uuid().optional(), add_to_stock: z.boolean(), notes: z.string().max(8000).optional(),
  lines: z.array(z.object({ part_id: z.string().uuid().optional(), description: z.string().trim().min(1).max(500), qty: z.number().finite().positive().max(1_000_000_000) })).min(1).max(800),
});
export function registerPlannedOrderAction() {
  platform().actions.registerHandler("purchases.plan-order", async ctx => {
    const p = PlanOrder.parse(ctx.args);
    if (p.expected_arrival && !fieldDay(p.expected_arrival)) throw new ActionRefusal("Choose a valid expected date.");
    const ids = [...new Set(p.lines.flatMap(l => l.part_id ? [l.part_id] : []))];
    const parts = await platform().entities.lookupMany(ctx.orgId, ids.map(id => ({ kind: "inventory:part", id })), { userId: ctx.userId ?? undefined });
    if (parts.length !== ids.length) throw new ActionRefusal("One of the order's stock records is missing or unavailable.");
    if (p.source_file_id && !(await platform().files.describe(ctx.orgId, [p.source_file_id]))?.length) throw new ActionRefusal("Upload the source file to this workspace first.");
    const fingerprint = createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<PurchasesDB>;
    const saved = await db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`planned-order:${p.request_key}`}, 0))`.execute(trx);
      const old = await trx.selectFrom("purchases_orders").select(["id", "metadata"]).where(sql<boolean>`metadata->>'planned_request_key' = ${p.request_key}`).executeTakeFirst();
      if (old) {
        const metadata = old.metadata as Record<string, unknown>;
        if (metadata.planned_fingerprint !== fingerprint) throw new ActionRefusal("That request already created a different order. Open it before changing the request.");
        return { order_id: old.id, already_recorded: true };
      }
      const order = await trx.insertInto("purchases_orders").values({ vendor: p.vendor, status: "planned", expected_arrival: p.expected_arrival ?? null,
        tracking_number: p.tracking_number ?? null,
        // Whoever planned it owns the parcel: the arrival sweep asks them alone.
        tracking_added_by_user_id: p.tracking_number ? ctx.userId ?? null : null, add_to_stock: p.add_to_stock, notes: p.notes ?? null,
        metadata: { planned_request_key: p.request_key, planned_fingerprint: fingerprint, source_file_id: p.source_file_id ?? null } } as never).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("purchases_order_items").values(p.lines.map(l => ({ order_id: order.id, part_id: l.part_id ?? null, description: l.description, qty: l.qty, metadata: {} })) as never).execute();
      return { order_id: order.id, already_recorded: false };
    });
    if (p.source_file_id) await platform().files.attach(ctx.orgId, { fileId: p.source_file_id, source_module: "purchases", source_type: "order", source_id: saved.order_id, role: "source" });
    if (!saved.already_recorded) {
      await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "order_created", ref: { module: "purchases", entityType: "order", entityId: saved.order_id }, diff: { vendor: p.vendor } });
      await platform().events.emit("purchases.order.created", { orgId: ctx.orgId, orderId: saved.order_id });
    }
    return { ok: true, changed: !saved.already_recorded, data: saved };
  });
}
