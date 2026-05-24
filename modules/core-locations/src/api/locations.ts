// /locations CRUD + tree-aware reads. Tracks depth server-side so
// callers don't need a recursive CTE to render the tree.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const locationsRouter = Router({ mergeParams: true });

const LocationCreate = z.object({
  name: z.string().min(1).max(160),
  short_name: z.string().max(60).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  kind: z.enum(["container", "area"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const LocationUpdate = LocationCreate.partial();

locationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("core_locations_locations")
      .select([
        "id",
        "name",
        "short_name",
        "parent_id",
        "depth",
        "kind",
        "metadata",
        "created_at",
        "updated_at",
      ])
      // Stable order: shallow first, then alpha. Makes a tree
      // render trivial without a recursive CTE.
      .orderBy("depth")
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  }),
);

locationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_locations_locations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "location not found" } });
      return;
    }
    res.json(row);
  }),
);

locationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
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
        .selectFrom("core_locations_locations")
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
      .insertInto("core_locations_locations")
      .values({
        name: parsed.data.name,
        short_name: parsed.data.short_name ?? null,
        parent_id: parsed.data.parent_id ?? null,
        depth,
        kind: parsed.data.kind ?? "area",
        metadata: parsed.data.metadata ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "location_created",
      ref: { module: "core-locations", entityType: "location", entityId: inserted.id },
      diff: { name: inserted.name, parent_id: inserted.parent_id, depth: inserted.depth },
    });
    void platform().events.emit("core-locations.location.created", {
      orgId: ctx.org.id,
      locationId: inserted.id,
    });

    res.status(201).json(inserted);
  }),
);

locationsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = LocationUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    // If parent_id changes we have to re-compute depth for THIS row
    // and every descendant. Cheap: walk the tree once.
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.short_name !== undefined) patch.short_name = parsed.data.short_name;
    if (parsed.data.kind !== undefined) patch.kind = parsed.data.kind;
    if (parsed.data.metadata !== undefined) patch.metadata = parsed.data.metadata;

    if (parsed.data.parent_id !== undefined) {
      // Reject cycle: new parent_id can't be self or a descendant.
      if (parsed.data.parent_id === id) {
        res.status(400).json({
          error: { code: "cycle", message: "A location cannot be its own parent." },
        });
        return;
      }
      let newDepth = 0;
      if (parsed.data.parent_id) {
        // Walk up from candidate parent; if we hit `id`, that's a cycle.
        let cursor: string | null = parsed.data.parent_id;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === id) {
            res.status(400).json({
              error: { code: "cycle", message: "Reparent would create a cycle." },
            });
            return;
          }
          if (seen.has(cursor)) break;
          seen.add(cursor);
          const parent: { parent_id: string | null; depth: number } | undefined =
            await db
              .selectFrom("core_locations_locations")
              .select(["parent_id", "depth"])
              .where("id", "=", cursor)
              .executeTakeFirst();
          if (!parent) {
            res.status(400).json({
              error: { code: "invalid_parent", message: "parent_id not found" },
            });
            return;
          }
          if (parent.parent_id === null) {
            newDepth = parent.depth + 1;
            break;
          }
          cursor = parent.parent_id;
        }
        // newDepth set above only when we hit a root via cursor.
        // If parent's depth is known directly, use that.
        const parentRow = await db
          .selectFrom("core_locations_locations")
          .select("depth")
          .where("id", "=", parsed.data.parent_id)
          .executeTakeFirstOrThrow();
        newDepth = parentRow.depth + 1;
      }
      patch.parent_id = parsed.data.parent_id;
      patch.depth = newDepth;
    }

    const updated = await db
      .updateTable("core_locations_locations")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "location not found" } });
      return;
    }
    // If parent changed, re-depth descendants. Simple BFS using the
    // depth field already maintained on every row.
    if (parsed.data.parent_id !== undefined) {
      await rebuildDescendantDepths(db, id);
    }
    void platform().events.emit("core-locations.location.updated", {
      orgId: ctx.org.id,
      locationId: id,
    });
    res.json(updated);
  }),
);

locationsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const deleted = await db
      .deleteFrom("core_locations_locations")
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "location not found" } });
      return;
    }
    void platform().events.emit("core-locations.location.deleted", {
      orgId: ctx.org.id,
      locationId: id,
    });
    res.status(204).end();
  }),
);

/** Walk descendants of `rootId` and rewrite their depth so they
 *  stay consistent after a reparent. Iterative BFS — no recursion
 *  budget, no SQL recursion required. */
async function rebuildDescendantDepths(
  db: ReturnType<typeof tenantDb>,
  rootId: string,
): Promise<void> {
  const root = await db
    .selectFrom("core_locations_locations")
    .select("depth")
    .where("id", "=", rootId)
    .executeTakeFirst();
  if (!root) return;
  // Queue holds [id, depth] pairs.
  let frontier: Array<{ id: string; depth: number }> = [
    { id: rootId, depth: root.depth },
  ];
  while (frontier.length > 0) {
    const parentIds = frontier.map((f) => f.id);
    const children = await db
      .selectFrom("core_locations_locations")
      .select(["id", "parent_id"])
      .where("parent_id", "in", parentIds)
      .execute();
    if (children.length === 0) break;
    const byParent = new Map<string, Array<{ id: string }>>();
    for (const c of children) {
      const arr = byParent.get(c.parent_id!) ?? [];
      arr.push({ id: c.id });
      byParent.set(c.parent_id!, arr);
    }
    const next: Array<{ id: string; depth: number }> = [];
    for (const f of frontier) {
      const cs = byParent.get(f.id) ?? [];
      for (const c of cs) {
        const childDepth = f.depth + 1;
        await db
          .updateTable("core_locations_locations")
          .set({ depth: childDepth })
          .where("id", "=", c.id)
          .execute();
        next.push({ id: c.id, depth: childDepth });
      }
    }
    frontier = next;
  }
}
