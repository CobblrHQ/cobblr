import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { placementConsumption } from "../stock-storage.js";
import type { InventoryDB } from "../db.js";
import { assertStorageReady } from "./storage.js";
import { stockMoved } from "./stock-moved.js";
import { recordConsumption } from "./stock-ledger.js";

const Consume = z.object({
  sourceId: z.string().trim().min(1).max(200),
  lines: z.array(z.object({ partId: z.string().uuid(), placements: z.number().int().positive().max(999_999_999) })).min(1).max(1000),
});

export function registerPlacementConsumption() {
  platform().actions.registerHandler("inventory.consume-with-loss", async ctx => {
    const parsed = Consume.safeParse(ctx.args);
    if (!parsed.success) throw new ActionRefusal("Give the run identifier and each stock record's placement count.");
    const p = parsed.data;
    const lines = [...p.lines].sort((a, b) => a.partId.localeCompare(b.partId));
    if (new Set(lines.map(l => l.partId)).size !== lines.length) throw new ActionRefusal("Give each stock record once, with its total placements.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const outcome = await db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`placements:${p.sourceId}`}, 0))`.execute(trx);
      const previous = await trx.selectFrom("inventory_consumption").select(["part_id", "delta", "reason"])
        .where("source_kind", "=", "inventory:placements").where("source_id", "=", p.sourceId).orderBy("part_id").execute();
      if (previous.length) {
        if (previous.length !== lines.length || previous.some((r, i) => r.part_id !== lines[i]!.partId || !r.reason?.startsWith(`${lines[i]!.placements} placements; `))) throw new ActionRefusal("This run identifier already belongs to different placements.");
        return { already_consumed: true, lines: previous.map(r => ({ partId: r.part_id, consumed: -Number(r.delta), newQty: 0, minQty: null as number | null })) };
      }
      const consumed: Array<{ partId: string; consumed: number; newQty: number; minQty: number | null }> = [];
      for (const line of lines) {
        const part = await trx.selectFrom("inventory_parts").selectAll().where("id", "=", line.partId).forUpdate().executeTakeFirst();
        if (!part || part.archived || part.state !== "active" || part.metadata.tracked_by) throw new ActionRefusal("Choose active count stock kept here.");
        await assertStorageReady(trx, ctx.orgId, part.id);
        const attrition = part.metadata.attrition_pct == null ? 0 : Number(part.metadata.attrition_pct);
        let take;
        try { take = placementConsumption(line.placements, attrition); }
        catch { throw new ActionRefusal("Choose a whole placement count and an attrition percentage from 0 to 100."); }
        if (Number(part.qty) < take) throw new ActionRefusal(`${part.name} has ${part.qty} left; these placements need ${take} including attrition.`);
        await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty - ${take}::numeric`, updated_at: new Date() }).where("id", "=", part.id).execute();
        await recordConsumption(trx, { partId: part.id, delta: -take, reason: `${line.placements} placements; ${attrition}% attrition`, sourceKind: "inventory:placements", sourceId: p.sourceId, byUser: ctx.userId ?? null });
        consumed.push({ partId: part.id, consumed: take, newQty: Number(part.qty) - take, minQty: part.min_qty == null ? null : Number(part.min_qty) });
      }
      return { already_consumed: false, lines: consumed };
    });
    if (!outcome.already_consumed) for (const line of outcome.lines) {
      await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId ?? null, action: "stock_consumed", ref: { module: "inventory", entityType: "part", entityId: line.partId }, diff: { delta: -line.consumed, source: p.sourceId } });
      await stockMoved(db, ctx.orgId, { partId: line.partId, delta: -line.consumed, newQty: line.newQty, minQty: line.minQty, reason: "Placements completed", ledger: false });
    }
    return { ok: true, changed: !outcome.already_consumed, data: outcome };
  });
}
