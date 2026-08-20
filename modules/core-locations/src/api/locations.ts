// /locations CRUD + tree-aware reads. Tracks depth server-side so
// callers don't need a recursive CTE to render the tree.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { DUPLICATE_SIBLING, duplicateSiblingMessage, siblingNamed } from "./siblings.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const locationsRouter = Router({ mergeParams: true });

const LocationCreate = z.object({
  name: z.string().min(1).max(160),
  short_name: z.string().max(60).nullable().optional(),
  parent_id: z.string().uuid().nullable().optional(),
  // Two bins genuinely both called "Bin" is a real thing people have. Refusing
  // that outright would be a rule about tidiness rather than correctness, so
  // the duplicate is available on purpose — it just cannot happen by accident.
  allow_duplicate: z.boolean().optional(),
  // The parent BY NAME. A person says "in the Garage", not a uuid, and so does
  // every sentence-shaped caller: a chat message, a shipped command, a CSV
  // import. Without it, anything holding a name had to search first, and a
  // caller who simply sent `parent` had it dropped by this schema and got a
  // top-level location while being told it worked.
  parent: z.string().min(1).max(160).optional(),
  kind: z.enum(["container", "area"]).optional(),
  metadata: z.record(z.unknown()).optional(),
  description: z.string().max(8_000).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  image_path: z.string().max(500).nullable().optional(),
});

const LocationUpdate = LocationCreate.partial();

/** The ids of one parent's children, in the order they should appear.
 *  Shared with the core-locations:reorder ACTION so a person dragging in the
 *  tree and the assistant reordering by name mean exactly the same thing. */
export const ReorderIds = z.array(z.string().uuid()).min(1).max(2000);

/** Write a sibling group's display order: each id's `position` becomes its
 *  index. Only touches the rows named. */
export async function applyOrder(
  db: ReturnType<typeof tenantDb>,
  ids: string[],
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (let i = 0; i < ids.length; i++) {
      await trx
        .updateTable("core_locations_locations")
        .set({ position: i })
        .where("id", "=", ids[i]!)
        .execute();
    }
  });
}

// Columns this module maintains itself. They are declared on the entity kind
// (so they can be read and talked about) and marked readOnly there, but a
// caller can still put one in a request body — and zod STRIPS unknown keys, so
// it vanished before the handler saw it and the update returned 200 with a
// fresh updated_at. Ask Cobb set `position` across twelve racks that way, read
// them back, and correctly reported that nothing had moved.
//
// The entity-writer seam refuses these too (sync-writer.ts). Both paths need
// it: the seam is what the kernel calls, and THIS route is what the kind
// declares as its update endpoint, so it is the one an assistant or an API
// client actually hits.
const SERVER_OWNED: Record<string, string> = {
  position:
    "sibling order is set by dragging in the tree (POST /reorder with the sibling ids in order), not by updating a location",
  depth: "depth follows parent_id and is recomputed on every move",
};

/** 400 naming any server-owned field in the body, or null to carry on. */
function refuseServerOwned(body: unknown): { code: string; message: string } | null {
  const keys = Object.keys((body ?? {}) as Record<string, unknown>);
  const refused = keys.filter((k) => k in SERVER_OWNED);
  if (refused.length === 0) return null;
  return {
    code: "server_owned_field",
    message: `Can't set ${refused.join(", ")} on a location: ${refused
      .map((k) => SERVER_OWNED[k])
      .join("; ")}.`,
  };
}

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
        "position",
        "kind",
        "metadata",
        "created_at",
        "updated_at",
      ])
      // Stable order: shallow first, then the user's manual sibling order
      // (`position`, set via /reorder), then alpha as the tiebreaker. Makes a
      // tree render trivial without a recursive CTE.
      .orderBy("depth")
      .orderBy("position")
      .orderBy("name")
      .execute();
    res.json({ items: rows });
  }),
);

// Persist a sibling group's display order. Body `{ ids: [...] }` in the desired
// order → each location's `position` set to its index. Defined before the
// "/:id" routes so it's unambiguous (and it's a POST, so no method clash). Only
// touches the rows named; callers send one parent's children at a time.
// AI-ACTION: core-locations:reorder
locationsRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = z.object({ ids: ReorderIds }).safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    await applyOrder(tenantDb(req), parsed.data.ids);
    res.json({ ok: true });
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
    // CREATE deliberately IGNORES a server-owned field rather than refusing it:
    // depth is computed from parent_id precisely so a client cannot spoof it,
    // and core-locations.test.ts pins that. There is also no expectation to
    // betray here — nothing existed to change. The refusal below is on UPDATE,
    // where a caller IS asking to change a stored value and would otherwise be
    // told it worked.
    const parsed = LocationCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // Resolve a parent given by name. Refused rather than ignored when it does
    // not resolve: putting the thing at the top level and reporting success is
    // the failure this whole seam keeps producing.
    if (parsed.data.parent && !parsed.data.parent_id) {
      const wanted = parsed.data.parent.trim();
      const matches = await db
        .selectFrom("core_locations_locations")
        .select(["id", "name"])
        .where(sql<boolean>`lower(name) = lower(${wanted})`)
        .execute();
      if (matches.length === 0) {
        res.status(400).json({
          error: { code: "unknown_parent", message: `There is no place called "${wanted}" to put this in.` },
        });
        return;
      }
      if (matches.length > 1) {
        res.status(400).json({
          error: {
            code: "ambiguous_parent",
            message: `More than one place is called "${wanted}", so I cannot tell which you mean. Use its id.`,
          },
        });
        return;
      }
      parsed.data.parent_id = matches[0]!.id;
    }

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

    if (!parsed.data.allow_duplicate) {
      const clash = await siblingNamed(db, parsed.data.parent_id ?? null, parsed.data.name);
      if (clash) {
        let placeName: string | null = null;
        if (parsed.data.parent_id) {
          const p = await db
            .selectFrom("core_locations_locations")
            .select("name")
            .where("id", "=", parsed.data.parent_id)
            .executeTakeFirst();
          placeName = p?.name ?? null;
        }
        res.status(409).json({
          error: {
            code: DUPLICATE_SIBLING,
            message: duplicateSiblingMessage(parsed.data.name, placeName),
            existing_id: clash.id,
          },
        });
        return;
      }
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
        description: parsed.data.description ?? null,
        notes: parsed.data.notes ?? null,
        image_path: parsed.data.image_path ?? null,
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
    const refused = refuseServerOwned(req.body);
    if (refused) {
      res.status(400).json({ error: refused });
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
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    if (parsed.data.image_path !== undefined) patch.image_path = parsed.data.image_path;

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

    // A rename arrives at the same bad state from the other side: calling this
    // one "Shelf 1" when its neighbour already is.
    if (parsed.data.name !== undefined && !parsed.data.allow_duplicate) {
      const self = await db
        .selectFrom("core_locations_locations")
        .select("parent_id")
        .where("id", "=", id)
        .executeTakeFirst();
      const parentId =
        parsed.data.parent_id !== undefined ? parsed.data.parent_id : (self?.parent_id ?? null);
      const clash = await siblingNamed(db, parentId, parsed.data.name, id);
      if (clash) {
        const place = parentId
          ? await db
              .selectFrom("core_locations_locations")
              .select("name")
              .where("id", "=", parentId)
              .executeTakeFirst()
          : null;
        res.status(409).json({
          error: {
            code: DUPLICATE_SIBLING,
            message: duplicateSiblingMessage(parsed.data.name, place?.name ?? null),
            existing_id: clash.id,
          },
        });
        return;
      }
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
