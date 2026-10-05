import { Router } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { MslSchema, changeStorage, initialStorage, storageReadiness } from "../stock-storage.js";
import { instanceOf, sessionUser, tenantContext, tenantDb, type InventoryDB } from "../db.js";
import { asyncHandler, badBody, requireCapability } from "./util.js";

const Change = z.object({
  partId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative(),
  operation: z.enum(["open", "dry", "start-bake", "complete-bake"]),
  minutes: z.number().finite().positive().max(100_000).optional(),
  temperature_c: z.number().finite().positive().max(500).optional(),
  instruction: z.string().trim().min(1).max(500).optional(),
});

export async function storageView(db: Kysely<InventoryDB>, orgId: string, id: string, now = new Date()) {
  const stored = await db.selectFrom("inventory_stock_storage").selectAll().where("part_id", "=", id).executeTakeFirst();
  const part = await db.selectFrom("inventory_parts").select(["metadata", "instance"]).where("id", "=", id).executeTakeFirst();
  if (!part) return null;
  if (!stored) {
    const config = await platform().instances.configOf(orgId, part.instance);
    const tracking = config?.package_receiving as { storage_tracking?: boolean } | undefined;
    if (!tracking?.storage_tracking) return null;
    return { part_id: id, revision: 0, state: initialStorage(now), msl: null, exposed_ms: 0, remaining_hours: null, usable: false, reason: "Record this package's storage history before use." };
  }
  const pairs = await platform().pairings.findBySources({ orgId, sourceKind: "inventory:part", sourceIds: [id], targetKind: "inventory:part", relationshipKind: "instance-of" });
  const typeId = pairs[0]?.targetId;
  const parent = typeId ? await db.selectFrom("inventory_parts").select("metadata").where("id", "=", typeId).executeTakeFirst() : null;
  const msl = MslSchema.safeParse(parent?.metadata.msl ?? part.metadata.msl);
  const floor = Number(part.metadata.msl_floor_hours);
  return { part_id: id, revision: stored.revision, state: stored.state, msl: msl.success ? msl.data : null,
    ...storageReadiness(stored.state, msl.success ? msl.data : null, now, Number.isFinite(floor) && floor > 0 ? floor : null) };
}

export async function assertStorageReady(db: Kysely<InventoryDB>, orgId: string, id: string): Promise<void> {
  const view = await storageView(db, orgId, id);
  if (view && !view.usable) throw new ActionRefusal(view.reason ?? "Check this stock's storage history before use.");
}

export const storageRouter = Router({ mergeParams: true });
storageRouter.get("/:id/storage", asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const row = await tenantDb(req).selectFrom("inventory_parts").select("id").where("id", "=", id).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such item." } });
  res.json(await storageView(tenantDb(req), tenantContext(req).org.id, id));
}));
// UI-SCREEN: /instances/<collection>/parts/<id> through StoragePanel and the action door
// AI-REACH: action inventory:change-storage
storageRouter.post("/:id/storage", asyncHandler(async (req, res) => {
  if (!await requireCapability(req, res, "inventory:change-storage")) return;
  const parsed = Change.safeParse(req.body);
  if (!parsed.success) return void badBody(res, parsed.error);
  const id = String(req.params.id);
  const row = await tenantDb(req).selectFrom("inventory_parts").select("id").where("id", "=", id).where("instance", "=", instanceOf(req)).executeTakeFirst();
  if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No such item." } });
  const result = normaliseActionResult(await platform().actions.invoke("inventory:change-storage", {
    orgId: tenantContext(req).org.id, userId: sessionUser(req).id, entity: { kind: "inventory:part", id }, args: { ...parsed.data, partId: id },
    event: { name: null, payload: {}, actor: { user_id: sessionUser(req).id, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "user-invoked" },
  }), "inventory.change-storage");
  if (!result.ok) throw new ActionRefusal(typeof result.error === "string" ? result.error : "Storage did not change.");
  res.json(await storageView(tenantDb(req), tenantContext(req).org.id, id));
}));

export function registerStorageActions() {
  platform().actions.registerHandler("inventory.change-storage", async ctx => {
    const parsed = Change.safeParse(ctx.args);
    if (!parsed.success) throw new ActionRefusal("Choose a storage change and its current revision.");
    const id = ctx.entity?.id ?? parsed.data.partId;
    if (!id) throw new ActionRefusal("Choose the stock to change.");
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<InventoryDB>;
    const changed = await db.transaction().execute(async trx => {
      const part = await trx.selectFrom("inventory_parts").select(["id", "archived", "state", "instance"]).where("id", "=", id).forUpdate().executeTakeFirst();
      if (!part || part.archived || part.state !== "active") throw new ActionRefusal("Choose active stock.");
      const stored = await trx.selectFrom("inventory_stock_storage").selectAll().where("part_id", "=", id).executeTakeFirst();
      if (!stored) {
        const config = await platform().instances.configOf(ctx.orgId, part.instance);
        const tracking = config?.package_receiving as { storage_tracking?: boolean } | undefined;
        if (!tracking?.storage_tracking) throw new ActionRefusal("This collection does not track package storage.");
      }
      const revision = stored?.revision ?? 0;
      if (revision !== parsed.data.revision) throw new ActionRefusal("This stock's storage changed. Reload it first.");
      const now = new Date();
      const p = parsed.data;
      let state;
      try {
        state = changeStorage(stored?.state ?? initialStorage(now), p.operation === "start-bake"
          ? { operation: p.operation, minutes: p.minutes!, temperature_c: p.temperature_c!, instruction: p.instruction! }
          : { operation: p.operation }, now);
      } catch (e) { throw new ActionRefusal(e instanceof Error ? e.message : "Give the bake duration, temperature and manufacturer instruction."); }
      await trx.insertInto("inventory_stock_storage").values({ part_id: id, state, revision: revision + 1 })
        .onConflict(oc => oc.column("part_id").doUpdateSet({ state, revision: revision + 1, updated_at: now })).execute();
      return { revision: revision + 1, state };
    });
    await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId ?? null, action: "part_storage_changed", ref: { module: "inventory", entityType: "part", entityId: id }, diff: { operation: parsed.data.operation } });
    return { ok: true, changed: true, data: changed };
  });
}
