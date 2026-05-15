// /locations — list (flat for now; tree-aware UI does its own
// re-shaping) + create. Depth is server-computed from parent.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";

export const locationsRouter = Router({ mergeParams: true });

const LocationCreate = z.object({
  name: z.string().min(1).max(160),
  short_name: z.string().max(60).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  kind: z.enum(["container", "area"]).optional(),
});

locationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("inventory_locations")
      .select(["id", "name", "short_name", "parent_id", "depth", "kind", "metadata", "created_at"])
      // Stable order: shallow first, then alpha. Makes a tree-y
      // render trivial without a recursive CTE.
      .orderBy("depth")
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  }),
);

locationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = LocationCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // Depth = parent's depth + 1. Cheap lookup; avoids recursive
    // computation when rendering the tree.
    let depth = 0;
    if (parsed.data.parent_id) {
      const parent = await db
        .selectFrom("inventory_locations")
        .select("depth")
        .where("id", "=", parsed.data.parent_id)
        .executeTakeFirst();
      if (!parent) {
        res.status(400).json({
          error: { code: "invalid_parent", message: "parent_id not found" },
        });
        return;
      }
      depth = parent.depth + 1;
    }

    const inserted = await db
      .insertInto("inventory_locations")
      .values({
        name: parsed.data.name,
        short_name: parsed.data.short_name ?? null,
        parent_id: parsed.data.parent_id ?? null,
        depth,
        kind: parsed.data.kind ?? "area",
      })
      .returning(["id", "name", "short_name", "parent_id", "depth", "kind", "metadata", "created_at"])
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "location_created",
      ref: { module: "inventory", entityType: "location", entityId: inserted.id },
      diff: { name: inserted.name, parent_id: inserted.parent_id, depth: inserted.depth },
    });
    platform().events.emit("inventory.location.created", {
      orgId: ctx.org.id,
      locationId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);
