import { z } from "zod";
import { sql, type Kysely } from "kysely";
import { ActionRefusal, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { recordConsumption } from "./stock-ledger.js";
import { stockMoved } from "./stock-moved.js";
const Request = z.object({ source_id: z.string().uuid(), source_kind: z.literal("builds:work-order"), input_kind: z.string().min(3), input_id: z.string().uuid(), output_kind: z.string().min(3), output_id: z.string().uuid(), accepted: z.number().int().min(0).max(1_000_000) });
export function registerAssemblyFinish() {
 platform().actions.registerHandler("inventory.finish-assembly-stock", async (ctx: ActionInvokeContext) => {
  const p = Request.parse(ctx.args);
  const owner = await platform().entities.lookup(ctx.orgId, p.source_kind, p.source_id, { userId: ctx.userId ?? undefined });
  const proof = owner?.fields.assembly_finish_proof as Record<string, unknown> | undefined;
  if (!proof || ["source_id", "input_kind", "input_id", "output_kind", "output_id", "accepted"].some(key => proof[key] !== p[key as keyof typeof p])) throw new ActionRefusal("The work order has no matching completed inspection transfer. Finish it from its authorized inspection station.");
  if (p.input_id === p.output_id) throw new ActionRefusal("Tested boards need a separate stock record from placed boards.");
  for (const [kind, id] of [[p.input_kind, p.input_id], [p.output_kind, p.output_id]]) if (!await platform().entities.lookup(ctx.orgId, kind!, id!, { userId: ctx.userId ?? undefined })) throw new ActionRefusal("Choose available placed and tested stock from this workspace.");
  const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>, source = `tested:${p.source_id}`;
  const changed = await db.transaction().execute(async trx => {
   await sql`select pg_advisory_xact_lock(hashtextextended(${source}, 0))`.execute(trx);
   const parts = await trx.selectFrom("inventory_parts").selectAll().where("id", "in", [p.input_id, p.output_id]).orderBy("id").forUpdate().execute();
   const input = parts.find(row => row.id === p.input_id), output = parts.find(row => row.id === p.output_id);
   if (!input || !output || parts.some(row => row.archived || row.state !== "active" || row.unit !== "each")) throw new ActionRefusal("Placed and tested boards must be available count stock.");
   const old = await trx.selectFrom("inventory_consumption").selectAll().where("source_kind", "=", "assembly-output").where("source_id", "=", source).executeTakeFirst();
   if (old) { if (old.part_id !== p.output_id || Number(old.delta) !== p.accepted) throw new ActionRefusal("This batch already finished with different tested stock."); return false; }
   const reserved = await trx.selectFrom("inventory_allocations").select(sql<string>`coalesce(sum(qty), 0)`.as("qty")).where("part_id", "=", p.input_id).where("status", "=", "reserved").executeTakeFirst();
   if (Number(input.qty) - Number(reserved?.qty ?? 0) < p.accepted) throw new ActionRefusal("There are not enough unreserved placed boards to finish this batch.");
   await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty - ${p.accepted}::numeric`, updated_at: new Date() }).where("id", "=", p.input_id).execute();
   await trx.updateTable("inventory_parts").set({ qty: sql<string>`qty + ${p.accepted}::numeric`, updated_at: new Date() }).where("id", "=", p.output_id).execute();
   await recordConsumption(trx, { partId: p.input_id, delta: -p.accepted, reason: "Boards passed inspection", sourceKind: "assembly-finish-input", sourceId: source, byUser: ctx.userId });
   await recordConsumption(trx, { partId: p.output_id, delta: p.accepted, reason: "Assembled and tested boards", sourceKind: "assembly-output", sourceId: source, byUser: ctx.userId });
   return true;
  });
  if (changed) for (const [partId, delta] of [[p.input_id, -p.accepted], [p.output_id, p.accepted]] as const) { const row = await db.selectFrom("inventory_parts").select(["qty", "min_qty"]).where("id", "=", partId).executeTakeFirstOrThrow(); await stockMoved(db, ctx.orgId, { partId, delta, newQty: Number(row.qty), minQty: row.min_qty == null ? null : Number(row.min_qty), reason: "assembly_tested", ledger: false }); }
  return { ok: true, changed, data: { accepted: p.accepted, output_id: p.output_id } };
 });
}
