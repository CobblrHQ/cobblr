import { Router } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { PasteLimits, beginPasteClock, changePasteStorage, pasteReadiness } from "../paste-lifecycle.js";
import { instanceOf, tenantDb, type InventoryDB } from "../db.js";
import { asyncHandler } from "./util.js";
const Change = z.object({ partId: z.string().uuid(), revision: z.number().int().nonnegative(), operation: z.enum(["configure", "out", "cold", "open"]), limits: PasteLimits.optional() });
export async function pasteView(db: Kysely<InventoryDB>, id: string, now = new Date()) {
  const stored = await db.selectFrom("inventory_paste_storage").selectAll().where("part_id", "=", id).executeTakeFirst();
  return stored ? { ...stored, ...pasteReadiness(stored.state, now) } : { part_id: id, revision: 0, state: null, usable: false, reason: "Record this jar's lot, expiry and manufacturer handling limits before use.", remaining_hours: null, ready_at: null };
}
export function registerPasteActions() {
  platform().actions.registerHandler("inventory.change-paste", async ctx => {
    const p = Change.parse(ctx.args);
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const part = await platform().entities.lookup(ctx.orgId, "inventory:part", p.partId, { userId: ctx.userId ?? undefined });
    const stock = part?.fields.stock as { shape?: string; unit?: string } | undefined;
    if (!part || part.retired || stock?.shape !== "liquid" || stock.unit !== "ml") throw new ActionRefusal("Configure this jar as liquid stock measured in ml before tracking its paste.");
    await db.transaction().execute(async trx => {
      const locked = await trx.selectFrom("inventory_parts").select(["id", "archived", "state"]).where("id", "=", p.partId).forUpdate().executeTakeFirst();
      if (!locked || locked.archived || locked.state !== "active") throw new ActionRefusal("Choose an active paste jar.");
      const stored = await trx.selectFrom("inventory_paste_storage").selectAll().where("part_id", "=", p.partId).executeTakeFirst();
      if ((stored?.revision ?? 0) !== p.revision) throw new ActionRefusal("This jar's handling changed. Reload it first.");
      if (p.operation === "configure" && stored) throw new ActionRefusal("Handling history and label limits cannot be reset. Receive a fresh jar for a new lot.");
      if (p.operation !== "configure" && !stored) throw new ActionRefusal("Record this jar's label limits first.");
      let state;
      try { state = p.operation === "configure" ? beginPasteClock(PasteLimits.parse(p.limits), new Date()) : changePasteStorage(stored!.state, p.operation, new Date()); }
      catch (e) { throw new ActionRefusal(e instanceof Error ? e.message : "Check the handling limits."); }
      await trx.insertInto("inventory_paste_storage").values({ part_id: p.partId, state, revision: p.revision + 1 }).onConflict(oc => oc.column("part_id").doUpdateSet({ state, revision: p.revision + 1, updated_at: new Date() })).execute();
    });
    await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "part_storage_changed", ref: { module: "inventory", entityType: "part", entityId: p.partId }, diff: { operation: p.operation, storage: "paste" } });
    return { ok: true, changed: true, data: await pasteView(db, p.partId) };
  });
  platform().actions.registerHandler("inventory.paste-readiness", async ctx => {
    const p = z.object({ partId: z.string().uuid() }).parse(ctx.args);
    if (!await platform().entities.lookup(ctx.orgId, "inventory:part", p.partId, { userId: ctx.userId ?? undefined })) throw new ActionRefusal("Choose an available paste jar.");
    return { ok: true, data: await pasteView(await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>, p.partId) };
  });
}
export const pasteRouter = Router({ mergeParams: true });
// AI-REACH: inventory:paste-readiness reads the same handling history and limits.
pasteRouter.get("/:id/paste", asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const part = await tenantDb(req).selectFrom("inventory_parts").select("id").where("id", "=", id).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!part) return void res.status(404).json({ error: { code: "not_found", message: "No such jar." } });
  res.json(await pasteView(tenantDb(req), id));
}));

export type PasteView = Awaited<ReturnType<typeof pasteView>>;
