// /builds — CRUD for builds + their components + their operations (routing),
// the "can I build?" query, the shortfall query, and the build action. A
// component line is EITHER a leaf inventory part OR a sub-assembly (another
// build); the build engine explodes nested sub-assemblies down to leaf parts
// (build-engine.ts, shared with the action handler). Operations are the ordered
// steps to make the build. Inventory is consumed only through the inventory API.

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
  explodeLeafComponents,
} from "../build-engine.js";
import { rollupOperation } from "../execution.js";
import { traceBackward, lineageCodes, type GenealogyLoaders, type RunInput } from "../genealogy.js";
import { scheduleEDD, type PlannedItem } from "../schedule.js";
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

// A component line is EITHER a leaf inventory part OR a sub-assembly build.
const ComponentCreate = z
  .object({
    part_id: z.string().uuid().optional(),
    sub_assembly_build_id: z.string().uuid().optional(),
    quantity: z.number().positive(),
    optional: z.boolean().optional(),
    notes: z.string().max(2_000).nullable().optional(),
  })
  .refine((d) => (d.part_id ? !d.sub_assembly_build_id : !!d.sub_assembly_build_id), {
    message: "Provide exactly one of part_id or sub_assembly_build_id",
  });

const OperationCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(8_000).nullable().optional(),
  est_minutes: z.number().nonnegative().nullable().optional(),
  resource_module: z.string().max(64).nullable().optional(),
  resource_type: z.string().max(64).nullable().optional(),
  resource_id: z.string().max(200).nullable().optional(),
});
const OperationUpdate = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(8_000).nullable().optional(),
  status: z.enum(["todo", "doing", "done", "skipped"]).optional(),
  seq: z.number().int().optional(),
  est_minutes: z.number().nonnegative().nullable().optional(),
  resource_module: z.string().max(64).nullable().optional(),
  resource_type: z.string().max(64).nullable().optional(),
  resource_id: z.string().max(200).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
});

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

    // First-level lines for display: part lines get live stock; sub-assembly
    // lines get a name + their own "buildable now".
    const partRows = componentRows.filter((r) => r.part_id);
    const partStock = await readComponentStock(
      ctx.org.id,
      partRows.map((r) => ({ part_id: r.part_id as string, quantity: Number(r.quantity) || 0, optional: r.optional })),
    );
    const stockByLine = new Map(partRows.map((r, i) => [r.id, partStock[i]!]));

    const components = [];
    for (const r of componentRows) {
      if (r.part_id) {
        components.push({ ...r, kind: "part" as const, ...stockByLine.get(r.id)! });
      } else {
        const sub = await db
          .selectFrom("builds_builds")
          .select(["name"])
          .where("id", "=", r.sub_assembly_build_id!)
          .executeTakeFirst();
        const subLeaves = await explodeLeafComponents(ctx.org.id, r.sub_assembly_build_id!);
        const subBuildable = computeBuildable(await readComponentStock(ctx.org.id, subLeaves));
        components.push({
          ...r,
          kind: "subassembly" as const,
          name: sub?.name ?? "(unknown build)",
          per_build: Number(r.quantity) || 0,
          sub_max_buildable: subBuildable.max_buildable,
        });
      }
    }

    // "Buildable now" uses the EXPLODED leaf requirements (sub-assemblies included).
    const leaves = await explodeLeafComponents(ctx.org.id, build.id);
    const buildable = computeBuildable(await readComponentStock(ctx.org.id, leaves));

    const operationRows = await db
      .selectFrom("builds_operations")
      .selectAll()
      .where("build_id", "=", build.id)
      .orderBy("seq", "asc")
      .orderBy("created_at", "asc")
      .execute();

    // Execution log (rung 6): batch-load time + quantity entries for the whole
    // build, group by operation, and attach each operation's rollup.
    const [timeRows, qtyRows] = await Promise.all([
      db.selectFrom("builds_op_time").select(["operation_id", "kind", "minutes"]).where("build_id", "=", build.id).execute(),
      db.selectFrom("builds_op_qty").select(["operation_id", "kind", "quantity"]).where("build_id", "=", build.id).execute(),
    ]);
    const timeByOp = new Map<string, Array<{ kind: string; minutes: number }>>();
    for (const t of timeRows) {
      (timeByOp.get(t.operation_id) ?? timeByOp.set(t.operation_id, []).get(t.operation_id)!).push({ kind: t.kind, minutes: Number(t.minutes) || 0 });
    }
    const qtyByOp = new Map<string, Array<{ kind: string; quantity: number }>>();
    for (const q of qtyRows) {
      (qtyByOp.get(q.operation_id) ?? qtyByOp.set(q.operation_id, []).get(q.operation_id)!).push({ kind: q.kind, quantity: Number(q.quantity) || 0 });
    }
    const operations = operationRows.map((op) => ({
      ...op,
      rollup: rollupOperation(timeByOp.get(op.id) ?? [], qtyByOp.get(op.id) ?? []),
    }));

    res.json({ build, components, buildable, operations });
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
// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.post(
  "/builds/:id/components",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ComponentCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const buildId = req.params.id!;
    const db = tenantDb(req);

    // Guard against a build referencing itself as a sub-assembly. Deeper
    // (transitive) cycles are caught + skipped by the explosion walk.
    if (parsed.data.sub_assembly_build_id) {
      if (parsed.data.sub_assembly_build_id === buildId) {
        res
          .status(400)
          .json({ error: { code: "invalid_subassembly", message: "A build can't be its own sub-assembly" } });
        return;
      }
      const sub = await db
        .selectFrom("builds_builds")
        .select(["id"])
        .where("id", "=", parsed.data.sub_assembly_build_id)
        .executeTakeFirst();
      if (!sub) {
        res.status(400).json({ error: { code: "not_found", message: "sub-assembly build not found" } });
        return;
      }
    }

    const row = await db
      .insertInto("builds_components")
      .values({
        build_id: buildId,
        part_id: parsed.data.part_id ?? null,
        sub_assembly_build_id: parsed.data.sub_assembly_build_id ?? null,
        quantity: String(parsed.data.quantity),
        optional: parsed.data.optional ?? false,
        notes: parsed.data.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
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

// ───────────────────────── operations (routing) ─────────────────────────
buildsRouter.get(
  "/builds/:id/operations",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("builds_operations")
      .selectAll()
      .where("build_id", "=", req.params.id!)
      .orderBy("seq", "asc")
      .orderBy("created_at", "asc")
      .execute();
    res.json({ items });
  }),
);

// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.post(
  "/builds/:id/operations",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OperationCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const buildId = req.params.id!;
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    // Append at the end of the routing: next seq after the current max.
    const max = await db
      .selectFrom("builds_operations")
      .select(({ fn }) => [fn.max<number>("seq").as("m")])
      .where("build_id", "=", buildId)
      .executeTakeFirst();
    const nextSeq = (Number(max?.m) || 0) + 1;

    const row = await db
      .insertInto("builds_operations")
      .values({
        build_id: buildId,
        seq: nextSeq,
        name: parsed.data.name.trim(),
        description: parsed.data.description ?? null,
        est_minutes: parsed.data.est_minutes != null ? String(parsed.data.est_minutes) : null,
        resource_module: parsed.data.resource_module ?? null,
        resource_type: parsed.data.resource_type ?? null,
        resource_id: parsed.data.resource_id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("builds.operation.created", {
      orgId: ctx.org.id,
      buildId,
      operationId: row.id,
      name: row.name,
    });
    res.status(201).json(row);
  }),
);

// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.patch(
  "/builds/:id/operations/:opId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = OperationUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const buildId = req.params.id!;
    const opId = req.params.opId!;
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    const before = await db
      .selectFrom("builds_operations")
      .select(["status"])
      .where("id", "=", opId)
      .where("build_id", "=", buildId)
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "operation not found" } });
      return;
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.seq !== undefined) patch.seq = parsed.data.seq;
    if (parsed.data.est_minutes !== undefined)
      patch.est_minutes = parsed.data.est_minutes != null ? String(parsed.data.est_minutes) : null;
    if (parsed.data.resource_module !== undefined) patch.resource_module = parsed.data.resource_module;
    if (parsed.data.resource_type !== undefined) patch.resource_type = parsed.data.resource_type;
    if (parsed.data.resource_id !== undefined) patch.resource_id = parsed.data.resource_id;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;

    const row = await db
      .updateTable("builds_operations")
      .set(patch)
      .where("id", "=", opId)
      .where("build_id", "=", buildId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Fire a wireable event when a step crosses INTO done (e.g. close a linked task).
    if (parsed.data.status === "done" && before.status !== "done") {
      await platform().events.emit("builds.operation.completed", {
        orgId: ctx.org.id,
        buildId,
        operationId: opId,
        name: row.name,
      });
    }
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
buildsRouter.delete(
  "/builds/:id/operations/:opId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    await db
      .deleteFrom("builds_operations")
      .where("id", "=", req.params.opId!)
      .where("build_id", "=", req.params.id!)
      .execute();
    res.status(204).end();
  }),
);

// ───────────── shop-floor execution log (rung 6): time + quantities ─────────────
const TimeLog = z.object({
  kind: z.enum(["labor", "machine", "setup"]).optional(),
  minutes: z.number().nonnegative(),
  notes: z.string().max(2_000).nullable().optional(),
});
const QtyLog = z.object({
  kind: z.enum(["good", "scrap", "rework"]),
  quantity: z.number().positive(),
  reason: z.string().max(2_000).nullable().optional(),
});

/** Confirm an operation belongs to the build before logging against it. */
async function operationOfBuild(db: ReturnType<typeof tenantDb>, buildId: string, opId: string) {
  return db
    .selectFrom("builds_operations")
    .select(["id", "name"])
    .where("id", "=", opId)
    .where("build_id", "=", buildId)
    .executeTakeFirst();
}

// Log time against an operation.
// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.post(
  "/builds/:id/operations/:opId/time",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = TimeLog.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const buildId = req.params.id!;
    const opId = req.params.opId!;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const op = await operationOfBuild(db, buildId, opId);
    if (!op) {
      res.status(404).json({ error: { code: "not_found", message: "operation not found" } });
      return;
    }
    const row = await db
      .insertInto("builds_op_time")
      .values({
        operation_id: opId,
        build_id: buildId,
        kind: parsed.data.kind ?? "labor",
        minutes: String(parsed.data.minutes),
        notes: parsed.data.notes ?? null,
        logged_by: session?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("builds.operation.time_logged", {
      orgId: ctx.org.id,
      buildId,
      operationId: opId,
      kind: row.kind,
      minutes: Number(row.minutes) || 0,
    });
    res.status(201).json(row);
  }),
);

// Log a quantity (good / scrap / rework) at an operation.
// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.post(
  "/builds/:id/operations/:opId/quantities",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = QtyLog.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const buildId = req.params.id!;
    const opId = req.params.opId!;
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const op = await operationOfBuild(db, buildId, opId);
    if (!op) {
      res.status(404).json({ error: { code: "not_found", message: "operation not found" } });
      return;
    }
    const row = await db
      .insertInto("builds_op_qty")
      .values({
        operation_id: opId,
        build_id: buildId,
        kind: parsed.data.kind,
        quantity: String(parsed.data.quantity),
        reason: parsed.data.reason ?? null,
        logged_by: session?.id ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // Scrap is the wireable signal (e.g. → a notification, or a quality log later).
    if (row.kind === "scrap") {
      await platform().events.emit("builds.operation.scrapped", {
        orgId: ctx.org.id,
        buildId,
        operationId: opId,
        operationName: op.name,
        quantity: Number(row.quantity) || 0,
        reason: row.reason,
      });
    }
    res.status(201).json(row);
  }),
);

// Full execution log for one operation (time + quantity entries).
buildsRouter.get(
  "/builds/:id/operations/:opId/log",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const [time, quantities] = await Promise.all([
      db.selectFrom("builds_op_time").selectAll().where("operation_id", "=", req.params.opId!).orderBy("logged_at", "asc").execute(),
      db.selectFrom("builds_op_qty").selectAll().where("operation_id", "=", req.params.opId!).orderBy("logged_at", "asc").execute(),
    ]);
    res.json({ time, quantities });
  }),
);

// ─────────────── "can I build?" + shortfall queries ───────────────
buildsRouter.get(
  "/builds/:id/buildable",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const leaves = await explodeLeafComponents(ctx.org.id, req.params.id!);
    const stock = await readComponentStock(ctx.org.id, leaves);
    res.json(computeBuildable(stock));
  }),
);

buildsRouter.get(
  "/builds/:id/shortfall",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const target = Math.max(1, Number(req.query.target ?? 1) || 1);
    const leaves = await explodeLeafComponents(ctx.org.id, req.params.id!);
    const stock = await readComponentStock(ctx.org.id, leaves);
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
const BuildRunBody = z.object({
  qty: z.number().int().positive().optional(),
  // Genealogy (rung 8): tag this run's output + which input lots it consumed.
  output_serial: z.string().max(200).nullable().optional(),
  input_lots: z.record(z.string().max(200)).optional(), // { [part_id]: lot_code }
});

// AI-ACTION: builds:build-one
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
    // Explode nested sub-assemblies to leaf inventory parts, then consume those.
    const leaves = await explodeLeafComponents(ctx.org.id, build.id);
    const consumed = await consumeComponents(ctx.org.id, session?.id ?? null, build.id, leaves, qty);

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

    // Genealogy (rung 8): record this run's input edges (the consumed leaves,
    // each optionally tagged with the lot consumed) + an output edge (the part
    // produced + an optional serial). These form the as-built lineage graph.
    const inputLots = parsed.data.input_lots ?? {};
    if (consumed.length > 0) {
      await db
        .insertInto("builds_run_inputs")
        .values(
          consumed.map((c) => ({
            run_id: run.id,
            part_id: c.part_id,
            lot_code: inputLots[c.part_id] ?? null,
            quantity: String(c.quantity),
          })),
        )
        .execute();
    }
    const outputSerial = parsed.data.output_serial?.trim() || null;
    if (build.output_part_id || outputSerial) {
      await db
        .insertInto("builds_run_outputs")
        .values({
          run_id: run.id,
          part_id: build.output_part_id ?? null,
          serial_code: outputSerial,
          quantity: String((Number(build.output_qty) || 1) * qty),
        })
        .execute();
    }

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
    const stock = await readComponentStock(ctx.org.id, leaves);
    res.status(201).json({ run, buildable: computeBuildable(stock) });
  }),
);

// ─────────────── genealogy / traceability (rung 8) ───────────────

// Run history for a build (each run + its output serial), newest first.
buildsRouter.get(
  "/builds/:id/runs",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const runs = await db
      .selectFrom("builds_runs")
      .leftJoin("builds_run_outputs", "builds_run_outputs.run_id", "builds_runs.id")
      .select([
        "builds_runs.id as id",
        "builds_runs.qty_built as qty_built",
        "builds_runs.built_at as built_at",
        "builds_run_outputs.serial_code as serial_code",
      ])
      .where("builds_runs.build_id", "=", req.params.id!)
      .orderBy("builds_runs.built_at", "desc")
      .execute();
    res.json({ items: runs });
  }),
);

/** DB-backed loaders for the pure genealogy walk, scoped to this tenant. */
function genealogyLoaders(db: ReturnType<typeof tenantDb>): GenealogyLoaders {
  return {
    getOutput: async (runId) => {
      const o = await db
        .selectFrom("builds_run_outputs")
        .select(["part_id", "serial_code", "quantity"])
        .where("run_id", "=", runId)
        .executeTakeFirst();
      return o ? { part_id: o.part_id, serial_code: o.serial_code, quantity: Number(o.quantity) || 0 } : null;
    },
    getInputs: async (runId): Promise<RunInput[]> => {
      const rows = await db
        .selectFrom("builds_run_inputs")
        .select(["part_id", "lot_code", "quantity"])
        .where("run_id", "=", runId)
        .execute();
      return rows.map((r) => ({ part_id: r.part_id, lot_code: r.lot_code, quantity: Number(r.quantity) || 0 }));
    },
    findRunByOutputSerial: async (code) => {
      const o = await db
        .selectFrom("builds_run_outputs")
        .select(["run_id"])
        .where("serial_code", "=", code)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      return o?.run_id ?? null;
    },
  };
}

// Backward as-built tree for one run ("what went into this unit").
buildsRouter.get(
  "/runs/:runId/genealogy",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const runId = req.params.runId!;
    const exists = await db.selectFrom("builds_runs").select(["id"]).where("id", "=", runId).executeTakeFirst();
    if (!exists) {
      res.status(404).json({ error: { code: "not_found", message: "run not found" } });
      return;
    }
    const tree = await traceBackward(runId, genealogyLoaders(db));
    res.json({ tree, lineage: lineageCodes(tree) });
  }),
);

// Trace a lot/serial code: which runs produced it, which consumed it.
buildsRouter.get(
  "/trace",
  asyncHandler(async (req, res) => {
    const code = String(req.query.code ?? "").trim();
    if (!code) return badBody(res, { issues: [{ message: "code is required" }] } as never);
    const db = tenantDb(req);
    const [produced, consumed] = await Promise.all([
      db
        .selectFrom("builds_run_outputs")
        .innerJoin("builds_runs", "builds_runs.id", "builds_run_outputs.run_id")
        .innerJoin("builds_builds", "builds_builds.id", "builds_runs.build_id")
        .select(["builds_runs.id as run_id", "builds_builds.name as build_name", "builds_run_outputs.quantity as quantity", "builds_runs.built_at as built_at"])
        .where("builds_run_outputs.serial_code", "=", code)
        .execute(),
      db
        .selectFrom("builds_run_inputs")
        .innerJoin("builds_runs", "builds_runs.id", "builds_run_inputs.run_id")
        .innerJoin("builds_builds", "builds_builds.id", "builds_runs.build_id")
        .select(["builds_runs.id as run_id", "builds_builds.name as build_name", "builds_run_inputs.part_id as part_id", "builds_run_inputs.quantity as quantity", "builds_runs.built_at as built_at"])
        .where("builds_run_inputs.lot_code", "=", code)
        .execute(),
    ]);
    res.json({ code, produced, consumed });
  }),
);

// ─────────────── planned production + scheduling (rung 7) ───────────────
const PlannedCreate = z.object({
  build_id: z.string().uuid(),
  qty: z.number().positive().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.number().int().optional(),
  resource_label: z.string().max(120).nullable().optional(),
  notes: z.string().max(2_000).nullable().optional(),
});
const PlannedUpdate = z.object({
  qty: z.number().positive().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.number().int().optional(),
  resource_label: z.string().max(120).nullable().optional(),
  status: z.enum(["planned", "done", "cancelled"]).optional(),
  notes: z.string().max(2_000).nullable().optional(),
});

// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.post(
  "/planned",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlannedCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const build = await db.selectFrom("builds_builds").select(["id"]).where("id", "=", parsed.data.build_id).executeTakeFirst();
    if (!build) {
      res.status(400).json({ error: { code: "not_found", message: "build not found" } });
      return;
    }
    const row = await db
      .insertInto("builds_planned")
      .values({
        build_id: parsed.data.build_id,
        qty: String(parsed.data.qty ?? 1),
        due_date: parsed.data.due_date ?? null,
        priority: parsed.data.priority ?? 0,
        resource_label: parsed.data.resource_label ?? null,
        notes: parsed.data.notes ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("builds.planned.created", { orgId: ctx.org.id, plannedId: row.id, buildId: row.build_id });
    res.status(201).json(row);
  }),
);

// AI-REACH: part of the build workflow (components, operations, time) which is a designed multi-step surface; build-one and reverse-one are the doors
buildsRouter.patch(
  "/planned/:pid",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlannedUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const before = await db.selectFrom("builds_planned").select(["status"]).where("id", "=", req.params.pid!).executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "planned item not found" } });
      return;
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.qty !== undefined) patch.qty = String(parsed.data.qty);
    if (parsed.data.due_date !== undefined) patch.due_date = parsed.data.due_date;
    if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
    if (parsed.data.resource_label !== undefined) patch.resource_label = parsed.data.resource_label;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    const row = await db.updateTable("builds_planned").set(patch).where("id", "=", req.params.pid!).returningAll().executeTakeFirstOrThrow();
    if (parsed.data.status === "done" && before.status !== "done") {
      await platform().events.emit("builds.planned.completed", { orgId: ctx.org.id, plannedId: row.id, buildId: row.build_id });
    }
    res.json(row);
  }),
);

// AI-REACH: destructive on a record with no undo path through the ledger; delete_record covers kinds that declare it
buildsRouter.delete(
  "/planned/:pid",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    await db.deleteFrom("builds_planned").where("id", "=", req.params.pid!).execute();
    res.status(204).end();
  }),
);

// The schedule: EDD heuristic over the open (status='planned') items.
buildsRouter.get(
  "/schedule",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const rows = await db
      .selectFrom("builds_planned")
      .innerJoin("builds_builds", "builds_builds.id", "builds_planned.build_id")
      .select([
        "builds_planned.id as id",
        "builds_planned.build_id as build_id",
        "builds_builds.name as build_name",
        "builds_planned.qty as qty",
        "builds_planned.due_date as due_date",
        "builds_planned.priority as priority",
        "builds_planned.resource_label as resource_label",
      ])
      .where("builds_planned.status", "=", "planned")
      .execute();

    // Estimated minutes-each per build = Σ its operations' est_minutes.
    const buildIds = [...new Set(rows.map((r) => r.build_id))];
    const estByBuild = new Map<string, number>();
    if (buildIds.length > 0) {
      const ops = await db
        .selectFrom("builds_operations")
        .select(["build_id", "est_minutes"])
        .where("build_id", "in", buildIds)
        .execute();
      for (const o of ops) {
        estByBuild.set(o.build_id, (estByBuild.get(o.build_id) ?? 0) + (Number(o.est_minutes) || 0));
      }
    }

    const items: PlannedItem[] = rows.map((r) => ({
      id: r.id,
      build_id: r.build_id,
      build_name: r.build_name,
      qty: Number(r.qty) || 1,
      due_date: r.due_date,
      priority: r.priority,
      resource_label: r.resource_label,
      est_minutes_each: estByBuild.get(r.build_id) ?? 0,
    }));

    res.json(scheduleEDD(items, new Date().toISOString()));
  }),
);
