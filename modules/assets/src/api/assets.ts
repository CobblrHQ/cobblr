import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata, preserveServerManaged, coerceMetadata } from "./route-helpers.js";

export const assetsRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router (covers both the direct mount and the instance-items dispatch
// path). Finer per-action roles can layer on top. (Audit 2026-06-26 P0 #1.)
assetsRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

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
    // Create-then-place: location rides the placement seam
    // (placement-cutover-plan step 1); place() mirrors the legacy column.
    const { location_id: createLocationId, ...createRest } = parsed.data;
    const inserted = await db
      .insertInto("assets_assets")
      .values({
        ...createRest,
        instance: instanceOf(req),
        flags: parsed.data.flags ?? [],
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (createLocationId) {
      try {
        await platform().placement.place({
          orgId: ctx.org.id,
          containee: { kind: "assets:asset", id: inserted.id },
          container: { kind: "core-locations:location", id: createLocationId },
        });
        (inserted as { location_id?: string | null }).location_id = createLocationId;
      } catch {
        await db.updateTable("assets_assets").set({ location_id: createLocationId }).where("id", "=", inserted.id).execute();
        (inserted as { location_id?: string | null }).location_id = createLocationId;
      }
    }
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

    // Read the current row FIRST — the before-image for the change event AND
    // the source of truth for server-managed fields (metadata is written
    // wholesale; a stale client value must not clobber a server-stamped one).
    // Same pattern as inventory's part PATCH.
    const before = await db
      .selectFrom("assets_assets")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }

    const smNames = await platform().entities.serverManagedFields(ctx.org.id, "assets:asset");
    const beforeMeta = coerceMetadata((before as { metadata?: unknown }).metadata);
    if (parsed.data.metadata !== undefined) {
      parsed.data.metadata = preserveServerManaged(
        parsed.data.metadata as Record<string, unknown>,
        beforeMeta,
        smNames,
      );
    }

    // Location changes ride the placement seam (placement-cutover-plan
    // step 1) instead of the column write; parsed.data stays intact so the
    // activity diff and the change-event bags still carry the transition.
    const { location_id: patchLocationId, ...patchRest } = parsed.data;
    const updated = await db
      .updateTable("assets_assets")
      .set({ ...patchRest, updated_at: new Date() } as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "asset not found" } });
      return;
    }
    if (patchLocationId !== undefined) {
      try {
        if (patchLocationId) {
          await platform().placement.place({
            orgId: ctx.org.id,
            containee: { kind: "assets:asset", id },
            container: { kind: "core-locations:location", id: patchLocationId },
          });
        } else {
          await platform().placement.remove({
            orgId: ctx.org.id,
            containee: { kind: "assets:asset", id },
          });
        }
      } catch {
        await db.updateTable("assets_assets").set({ location_id: patchLocationId ?? null }).where("id", "=", id).execute();
      }
      (updated as { location_id?: string | null }).location_id = patchLocationId ?? null;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "asset_updated",
      ref: { module: "assets", entityType: "asset", entityId: id },
      diff: parsed.data,
    });
    // Flat before/after bags (native columns + flattened metadata) so a
    // transition wire can compare {{event.before.x}} vs {{event.after.x}}.
    // AWAITED: a reactor (e.g. core-mobility) writes back to this asset and
    // the client re-reads right after — the wire must finish first.
    const nativeChanges: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined && k !== "metadata") nativeChanges[k] = v;
    }
    const afterMeta =
      parsed.data.metadata !== undefined
        ? ((parsed.data.metadata as Record<string, unknown>) ?? {})
        : beforeMeta;
    await platform().events.emit("assets.asset.updated", {
      orgId: ctx.org.id,
      assetId: id,
      before: { ...before, ...beforeMeta },
      after: { ...before, ...nativeChanges, ...afterMeta },
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
