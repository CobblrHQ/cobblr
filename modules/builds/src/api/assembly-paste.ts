import { z } from "zod";
import type { Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import type { BuildsDB } from "../db.js";
import { assemblyOrderView } from "./assembly-orders.js";
import { revision } from "./board-revisions.js";
import { invoke, operator } from "./placement.js";
const Apply = z.object({ order_id: z.string().uuid(), part_id: z.string().uuid(), kind: z.string().min(3).max(120), amount_ml: z.number().finite().positive().max(1_000_000), confirmed_applied: z.literal(true) });
export function registerAssemblyPasteActions() {
 platform().actions.registerHandler("builds.apply-assembly-paste", async ctx => {
  await operator(ctx);
  const p = Apply.parse(ctx.args), db = await platform().tenants.getDb(ctx.orgId) as Kysely<BuildsDB>;
  const intent = await db.transaction().execute(async trx => {
   const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst(); const a = row?.assembly;
   if (!row || !a || !["released", "pasted"].includes(a.state)) throw new ActionRefusal("Release this kit before recording paste application.");
   if (a.paste_intent) {
    if (a.paste_intent.part_id !== p.part_id || a.paste_intent.kind !== p.kind || a.paste_intent.amount_ml !== p.amount_ml) throw new ActionRefusal("This work order already records different paste. Recover its original application.");
    return a.paste_intent;
   }
   const { spec } = await revision(trx, row.build_id);
   if (!spec.stencil_id || !await platform().entities.lookup(ctx.orgId, spec.stencil_kind, spec.stencil_id, { userId: ctx.userId ?? undefined })) throw new ActionRefusal("Link this revision's stencil before applying paste.");
   const part = await platform().entities.lookup(ctx.orgId, p.kind, p.part_id, { userId: ctx.userId ?? undefined }); const stock = part?.fields.stock as { shape?: string; unit?: string } | undefined;
   if (!part || part.retired || stock?.shape !== "liquid" || stock.unit !== "ml") throw new ActionRefusal("Choose available liquid paste measured in ml.");
   const ready = await invoke<{ usable: boolean; reason: string | null; revision: number; state: { lot: string } | null }>(ctx, "inventory:paste-readiness", { partId: p.part_id });
   if (!ready.usable || !ready.state) throw new ActionRefusal(ready.reason ?? "Check this paste's label and handling before use.");
   const saved = { part_id: p.part_id, kind: p.kind, lot_code: ready.state.lot, amount_ml: p.amount_ml, applied_at: new Date().toISOString(), stencil_id: spec.stencil_id, source: `assembly-paste:${row.id}`, handling_revision: ready.revision, applied_by: ctx.userId };
   await trx.updateTable("builds_planned").set({ assembly: { ...a, paste_intent: saved }, updated_at: new Date() }).where("id", "=", row.id).execute();
   return saved;
  });
  const latest = await db.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).executeTakeFirst();
  if (latest?.assembly?.paste) return { ok: true, changed: false, data: await assemblyOrderView(ctx, p.order_id) };
  const handling = await invoke<{ revision: number }>(ctx, "inventory:paste-readiness", { partId: intent.part_id });
  await invoke(ctx, "inventory:use-ready-paste", { partId: intent.part_id, amount_ml: intent.amount_ml, sourceId: intent.source, lot: intent.lot_code, revision: handling.revision });
  const changed = await db.transaction().execute(async trx => {
   const row = await trx.selectFrom("builds_planned").selectAll().where("id", "=", p.order_id).forUpdate().executeTakeFirst();
   if (!row?.assembly) throw new ActionRefusal("Reload the work order to recover its paste application.");
   if (row.assembly.paste) return false;
   await trx.updateTable("builds_planned").set({ assembly: { ...row.assembly, state: "pasted", paste: intent }, updated_at: new Date() }).where("id", "=", row.id).execute(); return true;
  });
  if (changed) await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "updated", ref: { module: "builds", entityType: "work-order", entityId: p.order_id }, diff: { paste_lot: intent.lot_code, amount_ml: intent.amount_ml } });
  return { ok: true, changed, data: await assemblyOrderView(ctx, p.order_id) };
 });
}
