import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

export const assetsRouter = Router({ mergeParams: true });

const AssetCreate = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().max(40).nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  type: z.string().max(120).nullable().optional(),
  state: z.string().max(40).optional(),
  excitement: z.number().int().min(0).max(5).optional(),
  quantity: z.number().int().min(0).optional(),
  serial_number: z.string().max(160).nullable().optional(),
  purchased_at: z.string().nullable().optional(),
  warranty_until: z.string().nullable().optional(),
  last_service_at: z.string().nullable().optional(),
  image_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  flags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ASSET_NATIVE_KEYS = new Set(Object.keys(AssetCreate.shape));
const AssetUpdate = AssetCreate.partial();

assetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("instance", "=", instanceOf(req))
      .orderBy("name")
      .limit(500)
      .execute();
    res.json({ items });
  }),
);

assetsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    res.json(row);
  }),
);

assetsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, ASSET_NATIVE_KEYS);
    const parsed = AssetCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const inserted = await db
      .insertInto("assets_assets")
      .values({
        ...parsed.data,
        instance: instanceOf(req),
        flags: parsed.data.flags ?? [],
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_created",
      ref: { module: "assets", entityType: "asset", entityId: inserted.id },
      diff: { name: parsed.data.name },
    });
    platform().events.emit("assets.asset.created", {
      orgId: ctx.org.id,
      assetId: inserted.id,
    });
    res.status(201).json(inserted);
  }),
);

assetsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const routed = routeUnknownToMetadata(req.body, ASSET_NATIVE_KEYS);
    const parsed = AssetUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const updated = await db
      .updateTable("assets_assets")
      .set({ ...parsed.data, updated_at: new Date() } as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_updated",
      ref: { module: "assets", entityType: "asset", entityId: id },
      diff: parsed.data,
    });
    res.json(updated);
  }),
);

assetsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const deleted = await db
      .deleteFrom("assets_assets")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_deleted",
      ref: { module: "assets", entityType: "asset", entityId: id },
    });
    res.status(204).end();
  }),
);

void sql;
