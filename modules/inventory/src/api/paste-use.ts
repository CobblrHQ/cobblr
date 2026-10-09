import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { pasteReadiness, changePasteStorage } from "../paste-lifecycle.js";
import { recordConsumption } from "./stock-ledger.js";
import { stockMoved } from "./stock-moved.js";
const Use = z.object({ partId: z.string().uuid(), amount_ml: z.number().finite().positive().max(1_000_000), sourceId: z.string().trim().min(1).max(200), lot: z.string().trim().min(1).max(160), revision: z.number().int().nonnegative() });
export function registerPasteUseActions() {
 platform().actions.registerHandler("inventory.use-ready-paste", async ctx => {
  const p = Use.parse(ctx.args);
  const part = await platform().entities.lookup(ctx.orgId, "inventory:part", p.partId, { userId: ctx.userId ?? undefined }); const stock = part?.fields.stock as { shape?: string; unit?: string } | undefined;
  const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
  const result = await db.transaction().execute(async trx => {
   await sql`select pg_advisory_xact_lock(hashtextextended(${`paste-use:${p.sourceId}`}, 0))`.execute(trx);
   const row = await trx.selectFrom("inventory_parts").selectAll().where("id", "=", p.partId).forUpdate().executeTakeFirst();
   if (!row) throw new ActionRefusal("Choose a paste jar kept here.");
   const old = await trx.selectFrom("inventory_consumption").select(["part_id", "delta", "reason"]).where("source_kind", "=", "assembly-paste").where("source_id", "=", p.sourceId).executeTakeFirst();
   const reason = `Paste lot ${p.lot}`;
   if (old) {
    if (old.part_id !== p.partId || Number(old.delta) !== -p.amount_ml || old.reason !== reason) throw new ActionRefusal("This application already consumed different paste.");
    return { changed: false, newQty: Number(row.qty), minQty: row.min_qty == null ? null : Number(row.min_qty) };
   }
   if (!part || part.retired || stock?.shape !== "liquid" || stock.unit !== "ml" || row.archived || row.state !== "active" || row.unit !== "ml" || row.metadata.tracked_by) throw new ActionRefusal("Choose active liquid paste measured in ml and kept here.");
   const stored = await trx.selectFrom("inventory_paste_storage").selectAll().where("part_id", "=", row.id).executeTakeFirst();
   if (!stored || stored.state.lot !== p.lot) throw new ActionRefusal("Check the original paste lot before application.");
   const ready = pasteReadiness(stored.state, new Date());
   if (!ready.usable) throw new ActionRefusal(ready.reason ?? "Check this paste before use.");
   if (stored.revision !== p.revision) throw new ActionRefusal("This paste's handling changed. Reload its application before use.");
   const reserved = await trx.selectFrom("inventory_allocations").select(sql<string>`coalesce(sum(qty), 0)`.as("qty")).where("part_id", "=", row.id).where("status", "=", "reserved").executeTakeFirst();
   if (Number(row.qty) - Number(reserved?.qty ?? 0) < p.amount_ml) throw new ActionRefusal("This jar has too little unreserved paste for the application.");
   if (!stored.state.opened_at) await trx.updateTable("inventory_paste_storage").set({ state: changePasteStorage(stored.state, "open", new Date()), revision: stored.revision + 1, updated_at: new Date() }).where("part_id", "=", row.id).execute();
   await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty - ${p.amount_ml}::numeric`, updated_at: new Date() }).where("id", "=", row.id).execute();
   await recordConsumption(trx, { partId: row.id, delta: -p.amount_ml, sourceKind: "assembly-paste", sourceId: p.sourceId, reason, byUser: ctx.userId });
   return { changed: true, newQty: Number(row.qty) - p.amount_ml, minQty: row.min_qty == null ? null : Number(row.min_qty) };
  });
  if (result.changed) await stockMoved(db, ctx.orgId, { partId: p.partId, delta: -p.amount_ml, newQty: result.newQty, minQty: result.minQty, reason: "Paste applied to boards", ledger: false });
  return { ok: true, changed: result.changed, data: result };
 });
}
