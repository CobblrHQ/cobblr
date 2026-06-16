// /builds — CRUD for builds + their components, the "can I build?" query, the
// shortfall query, and the build action. The consume + buildable math lives in
// build-engine.ts (shared with the action handler).

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import {
  readComponentStock,
  computeBuildable,
  computeShortfall,
  consumeComponents,
  type ComponentInput,
} from "../build-engine.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

export const buildsRouter = Router({ mergeParams: true });

const BuildCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(8_000).nullable().optional(),
  output_part_id: z.string().uuid().nullable().optional(),
  output_qty: z.number().positive().optional(),
  notes: z.string().max(8_000).nullable().optional(),
});
const BuildUpdate = BuildCreate.partial();

const ComponentCreate = z.object({
  part_id: z.string().uuid(),
  quantity: z.number().positive(),
  optional: z.boolean().optional(),
  notes: z.string().max(2_000).nullable().optional(),
});

async function loadComponents(
  db: ReturnType<typeof tenantDb>,
  buildId: string,
): Promise<ComponentInput[]> {
  const rows = await db
    .selectFrom("builds_components")
    .selectAll()
    .where("build_id", "=", buildId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => ({
    part_id: r.part_id,
    quantity: Number(r.quantity) || 0,
    optional: r.optional,
  }));
}

// ─────────────────────────── builds CRUD ───────────────────────────
buildsRouter.post(
  "/builds",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BuildCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .insertInto("builds_builds")
      .values({
        name: parsed.data.name.trim(),
        description: parsed.data.description ?? null,
        output_part_id: parsed.data.output_part_id ?? null,
        output_qty: String(parsed.data.output_qty ?? 1),
        notes: parsed.data.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("builds.build.created", { orgId: ctx.org.id, buildId: row.id });
    res.status(201).json(row);
  }),
);

buildsRouter.get(
  "/builds",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db.selectFrom("builds_builds").selectAll().orderBy("name").execute();
    res.json({ items });
  }),
);

buildsRouter.get(
  "/builds/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const build = await db
      .selectFrom("builds_builds")
      .selectAll()
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!build) {
      res.status(404).json({ error: { code: "not_found", message: "build not found" } });
      return;
    }
    const componentRows = await db
      .selectFrom("builds_components")
      .selectAll()
      .where("build_id", "=", build.id)
      .orderBy("created_at", "asc")
      .execute();
    const stock = await readComponentStock(
      ctx.org.id,
      componentRows.map((r) => ({ part_id: r.part_id, quantity: Number(r.quantity) || 0, optional: r.optional })),
    );
    // Merge the row ids back onto the stock view so the UI can delete a line.
    const components = componentRows.map((r, i) => ({ ...r, ...stock[i] }));
    const buildable = computeBuildable(stock);
    res.json({ build, components, buildable });
  }),
);

buildsRouter.patch(
  "/builds/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BuildUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.output_part_id !== undefined) patch.output_part_id = parsed.data.output_part_id;
    if (parsed.data.output_qty !== undefined) patch.output_qty = String(parsed.data.output_qty);
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    const row = await db
      .updateTable("builds_builds")
      .set(patch)
      .where("id", "=", req.params.id!)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "build not found" } });
      return;
    }
    res.json(row);
  }),
);

buildsRouter.delete(
  "/builds/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    await db.deleteFrom("builds_builds").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);

// ───────────────────────── components ─────────────────────────
buildsRouter.post(
  "/builds/:id/components",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ComponentCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const row = await db
      .insertInto("builds_components")
      .values({
        build_id: req.params.id!,
        part_id: parsed.data.part_id,
        quantity: String(parsed.data.quantity),
        optional: parsed.data.optional ?? false,
        notes: parsed.data.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

buildsRouter.delete(
  "/builds/:id/components/:cid",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    await db
      .deleteFrom("builds_components")
      .where("id", "=", req.params.cid!)
      .where("build_id", "=", req.params.id!)
      .execute();
    res.status(204).end();
  }),
);

// ─────────────── "can I build?" + shortfall queries ───────────────
buildsRouter.get(
  "/builds/:id/buildable",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const comps = await loadComponents(db, req.params.id!);
    const stock = await readComponentStock(ctx.org.id, comps);
    res.json(computeBuildable(stock));
  }),
);

buildsRouter.get(
  "/builds/:id/shortfall",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const target = Math.max(1, Number(req.query.target ?? 1) || 1);
    const comps = await loadComponents(db, req.params.id!);
    const stock = await readComponentStock(ctx.org.id, comps);
    const shortfall = computeShortfall(stock, target);
    if (shortfall.length > 0) {
      await platform().events.emit("builds.shortfall.detected", {
        orgId: ctx.org.id,
        buildId: req.params.id,
        target,
        shortfall,
      });
    }
    res.json({ target, shortfall });
  }),
);

// ─────────────────────────── build! ───────────────────────────
const BuildRunBody = z.object({ qty: z.number().int().positive().optional() });

buildsRouter.post(
  "/builds/:id/build",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = BuildRunBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const qty = parsed.data.qty ?? 1;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const build = await db
      .selectFrom("builds_builds")
      .selectAll()
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!build) {
      res.status(404).json({ error: { code: "not_found", message: "build not found" } });
      return;
    }
    const comps = await loadComponents(db, build.id);
    const consumed = await consumeComponents(ctx.org.id, session?.id ?? null, build.id, comps, qty);

    const run = await db
      .insertInto("builds_runs")
      .values({
        build_id: build.id,
        qty_built: String(qty),
        consumed: sql`${JSON.stringify(consumed)}::jsonb` as never,
        built_by: session?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // If this build produces a tracked part, increment it.
    if (build.output_part_id) {
      const made = (Number(build.output_qty) || 1) * qty;
      await platform()
        .actions.invoke("inventory:adjust-stock", {
          orgId: ctx.org.id,
          userId: session?.id ?? null,
          entity: { kind: "inventory:part", id: build.output_part_id },
          event: {
            name: "builds.build.completed",
            payload: {},
            actor: { user_id: session?.id ?? null, display_name: null, auth_method: "session" },
            timestamp: new Date().toISOString(),
            trigger_type: "event",
          },
          args: { partId: build.output_part_id, delta: made, reason: `build-output:${build.id}` },
          entityKind: "inventory:part",
          entityId: build.output_part_id,
        })
        .catch((e) => console.error("[builds] output adjust-stock failed:", (e as Error).message));
    }

    await platform().events.emit("builds.build.completed", {
      orgId: ctx.org.id,
      buildId: build.id,
      qtyBuilt: qty,
    });

    // Return the run + the fresh buildable so the UI updates without a round-trip.
    const stock = await readComponentStock(ctx.org.id, comps);
    res.status(201).json({ run, buildable: computeBuildable(stock) });
  }),
);
