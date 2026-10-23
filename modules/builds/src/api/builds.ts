// /builds — CRUD for builds + their components + their operations (routing),
// the "can I build?" query, the shortfall query, and the build action. A
// component line is EITHER a leaf inventory part OR a sub-assembly (another
// build); the build engine explodes nested sub-assemblies down to leaf parts
// (build-engine.ts, shared with the action handler). Operations are the ordered
// steps to make the build. Inventory is consumed only through the inventory API.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import { madeByWorkOrder } from "../work-orders.js";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import {
  readComponentStock,
  computeBuildable,
  computeShortfall,
  consumeComponents,
  explodeLeafComponents,
  buildableOf,
  consumePlan,
  planBuild,
  planLines,
  shortfallOf,
} from "../build-engine.js";
import { rollupOperation } from "../execution.js";
import { traceBackward, lineageCodes, nameGenealogy, type GenealogyLoaders, type RunInput } from "../genealogy.js";
import { nameRecords } from "@cobblr/platform-contract/record-subjects";
import { scheduleEDD, type PlannedItem } from "../schedule.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { resolveOutputPart } from "../output-part.js";
import { addComponent, addStep, changePlan, changeStep, logStepCount, logStepTime, addPlannedBuild, removeComponent, removePlan, removeStep } from "./build-steps.js";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { shortageSentence } from "../shortage.js";
import { buildUndoStep } from "../build-undo.js";

export const buildsRouter = Router({ mergeParams: true });

const BuildCreate = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(8_000).nullable().optional(),
  output_part_id: z.string().uuid().nullable().optional(),
  /** What the build makes, by name: the inventory part with that name, made
   *  when there is none. Ignored when output_part_id is given. */
  output_part_name: optionalField(z.string().min(1).max(200)),
  output_qty: z.number().positive().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  notes: z.string().max(8_000).nullable().optional(),
  /** A bundle's custom fields on the build ("Sells for"), merged into the bag. */
  metadata: z.record(z.unknown()).optional(),
});
const BuildUpdate = BuildCreate.partial();

// A component line is EITHER a leaf inventory part OR a sub-assembly build.
const ComponentCreate = z
  .object({
    part_id: z.string().uuid().optional(),
    sub_assembly_build_id: z.string().uuid().optional(),
    quantity: z.number().positive(),
    optional: z.boolean().optional(),
    // A sub-assembly line: take its output's stock first (default) or always make it.
    use_stock: z.boolean().optional(),
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
  name: z.string().min(1).max(200).optional(), // none-refused-ok: an operation always has a name
  description: z.string().max(8_000).nullable().optional(),
  status: z.enum(["todo", "doing", "done", "skipped"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  seq: z.number().int().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  est_minutes: z.number().nonnegative().nullable().optional(),
  resource_module: z.string().max(64).nullable().optional(),
  resource_type: z.string().max(64).nullable().optional(),
  resource_id: z.string().max(200).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
});

// ─────────────────────────── builds CRUD ───────────────────────────
// AI-REACH: crud
buildsRouter.post(
  "/builds",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    if (req.body?.metadata && Object.prototype.hasOwnProperty.call(req.body.metadata, "assembly")) {
      res.status(422).json({ error: { code: "use_revision_import", message: "Use the board revision importer to check these files." } });
      return;
    }
    const parsed = BuildCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    let outputPartId = parsed.data.output_part_id ?? null;
    if (!outputPartId && parsed.data.output_part_name) {
      const out = await resolveOutputPart(ctx.org.id, parsed.data.output_part_name);
      if (!out.ok) {
        res.status(409).json({ error: { code: "no_output_part", message: out.reason } });
        return;
      }
      outputPartId = out.partId;
    }
    const row = await db
      .insertInto("builds_builds")
      .values({
        name: parsed.data.name.trim(),
        description: parsed.data.description ?? null,
        output_part_id: outputPartId,
        output_qty: String(parsed.data.output_qty ?? 1),
        notes: parsed.data.notes ?? null,
        ...(parsed.data.metadata ? { metadata: sql`${JSON.stringify(parsed.data.metadata)}::jsonb` } : {}),
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().events.emit("builds.build.created", { orgId: ctx.org.id, buildId: row.id });
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "build_created",
      ref: { module: "builds", entityType: "build", entityId: row.id },
      diff: { name: row.name },
    });
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
        const subBuildable = await buildableOf(ctx.org.id, r.sub_assembly_build_id!);
        components.push({
          ...r,
          kind: "subassembly" as const,
          name: sub?.name ?? "(unknown build)",
          per_build: Number(r.quantity) || 0,
          sub_max_buildable: subBuildable.max_buildable,
        });
      }
    }

    // "Buildable now" takes stocked sub-assemblies first and makes the rest.
    const { plan: _bestPlan, ...buildable } = await buildableOf(ctx.org.id, build.id);
    // How each sub-assembly line is met for the quantity asked about (1 by default).
    const planQty = Math.max(1, Math.floor(Number(req.query.qty ?? 1)) || 1);
    const plan = await planBuild(ctx.org.id, build.id, planQty);
    for (const c of components) {
      if (c.kind !== "subassembly") continue;
      const met = plan.sub_assemblies.find((s) => s.build_id === c.sub_assembly_build_id);
      Object.assign(c, { from_stock: met?.from_stock ?? 0, to_make: met?.to_make ?? 0, plan_qty: planQty });
    }

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
      // A judged print's count belongs to the build, not to an operation.
      if (q.operation_id == null) continue;
      (qtyByOp.get(q.operation_id) ?? qtyByOp.set(q.operation_id, []).get(q.operation_id)!).push({ kind: q.kind, quantity: Number(q.quantity) || 0 });
    }
    const operations = operationRows.map((op) => ({
      ...op,
      rollup: rollupOperation(timeByOp.get(op.id) ?? [], qtyByOp.get(op.id) ?? []),
    }));

    // The build's yield across everything counted for it: per-operation logs
    // and judged prints alike (#4053), one number rather than two records.
    const r = rollupOperation([], qtyRows.map((q) => ({ kind: q.kind, quantity: Number(q.quantity) || 0 })));
    const quality = { good_qty: r.good_qty, scrap_qty: r.scrap_qty, yield_pct: r.yield_pct };

    // What a Build press adds to stock, named, so the sheet can say it before
    // anything is consumed.
    const outputPart = build.output_part_id ? await platform().entities.lookup(ctx.org.id, "inventory:part", build.output_part_id) : null;
    const output = build.output_part_id
      ? { part_id: build.output_part_id, name: outputPart?.title ?? null, qty: outputPart ? Number(outputPart.fields?.qty ?? 0) : null }
      : null;

    // What is short to make the quantity asked about, after stocked sub-assemblies are taken.
    const planStock = await readComponentStock(ctx.org.id, [...plan.from_stock, ...plan.leaves]);
    const shortage = shortageSentence(planStock.map((c) => ({ ...c, per_build: c.quantity })), 1);
    res.json({ build, components, buildable, operations, quality, output, plan_qty: planQty, shortage, plan: planLines(plan) });
  }),
);

// AI-REACH: crud
buildsRouter.patch(
  "/builds/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    if (req.body?.metadata && Object.prototype.hasOwnProperty.call(req.body.metadata, "assembly")) {
      res.status(422).json({ error: { code: "immutable_revision", message: "Import changed board files as a new revision." } });
      return;
    }
    const parsed = BuildUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.output_part_id !== undefined) patch.output_part_id = parsed.data.output_part_id;
    else if (parsed.data.output_part_name) {
      const out = await resolveOutputPart(tenantContext(req).org.id, parsed.data.output_part_name);
      if (!out.ok) {
        res.status(409).json({ error: { code: "no_output_part", message: out.reason } });
        return;
      }
      patch.output_part_id = out.partId;
    }
    if (parsed.data.output_qty !== undefined) patch.output_qty = String(parsed.data.output_qty);
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    // Custom fields MERGE into the stored bag, so saving one keeps the others.
    const set = withMetadataMerged(parsed.data.metadata !== undefined ? { ...patch, metadata: parsed.data.metadata } : patch);
    // The row as it was: the record's history says what this edit changed (#4517).
    const before = await db.selectFrom("builds_builds").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    const row = await db
      .updateTable("builds_builds")
      .set(set as never)
      .where("id", "=", req.params.id!)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "build not found" } });
      return;
    }
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "build_updated",
      ref: { module: "builds", entityType: "build", entityId: row.id },
      diff: { ...patch, ...(parsed.data.metadata !== undefined ? { metadata: parsed.data.metadata } : {}) },
      before,
    });
    res.json(row);
  }),
);

// AI-REACH: crud
buildsRouter.delete(
  "/builds/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const order = await db.selectFrom("builds_planned").select("id").where("build_id", "=", req.params.id!).where("assembly", "is not", null).executeTakeFirst();
    if (order) throw new ActionRefusal("This revision has assembly work order history. Keep it for traceability.");
    await db.deleteFrom("builds_builds").where("id", "=", req.params.id!).execute();
    res.status(204).end();
  }),
);

// ───────────────────────── components ─────────────────────────
// AI-ACTION: builds:add-component
buildsRouter.post(
  "/builds/:id/components",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:add-component"))) return;
    const parsed = ComponentCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    try {
      res.status(201).json(await addComponent(tenantDb(req), req.params.id!, parsed.data));
    } catch (e) {
      if (e instanceof ActionRefusal) return void res.status(400).json({ error: { code: "invalid_subassembly", message: e.message } });
      throw e;
    }
  }),
);

const ComponentUpdate = z.object({ use_stock: z.boolean() });
// AI-REACH: action builds:set-sub-assembly-source
buildsRouter.patch(
  "/builds/:id/components/:cid",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:set-sub-assembly-source"))) return;
    const parsed = ComponentUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const row = await tenantDb(req)
      .updateTable("builds_components")
      .set({ use_stock: parsed.data.use_stock })
      .where("id", "=", req.params.cid!)
      .where("build_id", "=", req.params.id!)
      .where("sub_assembly_build_id", "is not", null)
      .returningAll()
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "No sub-assembly line with that id on this build." } });
    res.json(row);
  }),
);

// AI-ACTION: builds:remove-component
// UI-SCREEN: /builds (the sheet presses the action of this name, so the removal carries its Undo)
buildsRouter.delete(
  "/builds/:id/components/:cid",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:remove-component"))) return;
    await removeComponent(tenantDb(req), req.params.id!, req.params.cid!);
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

// AI-ACTION: builds:add-step
buildsRouter.post(
  "/builds/:id/operations",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:add-step"))) return;
    const parsed = OperationCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    res.status(201).json(await addStep(tenantDb(req), tenantContext(req).org.id, req.params.id!, parsed.data));
  }),
);

// AI-ACTION: builds:change-step
buildsRouter.patch(
  "/builds/:id/operations/:opId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:change-step"))) return;
    const parsed = OperationUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await changeStep(tenantDb(req), tenantContext(req).org.id, req.params.id!, req.params.opId!, parsed.data);
    if (!out) return void res.status(404).json({ error: { code: "not_found", message: "operation not found" } });
    res.json(out.row);
  }),
);

// AI-ACTION: builds:remove-step
buildsRouter.delete(
  "/builds/:id/operations/:opId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:remove-step"))) return;
    await removeStep(tenantDb(req), req.params.id!, req.params.opId!);
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
// AI-ACTION: builds:log-step-time
buildsRouter.post(
  "/builds/:id/operations/:opId/time",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:log-step-time"))) return;
    const parsed = TimeLog.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const op = await operationOfBuild(db, req.params.id!, req.params.opId!);
    if (!op) return void res.status(404).json({ error: { code: "not_found", message: "operation not found" } });
    res.status(201).json(await logStepTime(db, tenantContext(req).org.id, req.params.id!, op, parsed.data, sessionUser(req)?.id ?? null));
  }),
);

// Log a quantity (good / scrap / rework) at an operation.
// AI-ACTION: builds:log-step-count
buildsRouter.post(
  "/builds/:id/operations/:opId/quantities",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:log-step-count"))) return;
    const parsed = QtyLog.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const op = await operationOfBuild(db, req.params.id!, req.params.opId!);
    if (!op) return void res.status(404).json({ error: { code: "not_found", message: "operation not found" } });
    res.status(201).json(await logStepCount(db, tenantContext(req).org.id, req.params.id!, op, parsed.data, sessionUser(req)?.id ?? null));
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
    const { plan, ...buildable } = await buildableOf(ctx.org.id, req.params.id!);
    res.json({ ...buildable, sub_assemblies: plan.sub_assemblies, plan: planLines(plan) });
  }),
);

buildsRouter.get(
  "/builds/:id/shortfall",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const target = Math.max(1, Number(req.query.target ?? 1) || 1);
    const { plan, shortfall } = await shortfallOf(ctx.org.id, req.params.id!, target);
    if (shortfall.length > 0) {
      await platform().events.emit("builds.shortfall.detected", {
        orgId: ctx.org.id,
        buildId: req.params.id,
        target,
        shortfall,
      });
    }
    res.json({ target, shortfall, sub_assemblies: plan.sub_assemblies, plan: planLines(plan) });
  }),
);

// ─────────────────────────── build! ───────────────────────────
const BuildRunBody = z.object({
  qty: z.number().int().positive().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  // Genealogy (rung 8): tag this run's output + which input lots it consumed.
  output_serial: z.string().max(200).nullable().optional(),
  input_lots: z.record(z.string().max(200)).optional(), // { [part_id]: lot_code }
});

// AI-ACTION: builds:build-one
buildsRouter.post(
  "/builds/:id/build",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:build-one"))) return;
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
    if ((build.metadata as { assembly?: unknown }).assembly) throw new ActionRefusal("Use an assembly work order to place, reflow and inspect this board revision.");
    // Stocked sub-assemblies first, the rest exploded to leaf parts; consume both.
    const plan = await planBuild(ctx.org.id, build.id, qty);
    const consumed = await consumePlan(ctx.org.id, session?.id ?? null, build.id, plan);

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
        })
        .catch((e) => console.error("[builds] output adjust-stock failed:", (e as Error).message));
    }

    await platform().events.emit("builds.build.completed", {
      orgId: ctx.org.id,
      buildId: build.id,
      qtyBuilt: qty,
    });

    // Return the run + the fresh buildable so the UI updates without a round-trip.
    const { plan: _next, ...buildable } = await buildableOf(ctx.org.id, build.id);
    // The way back, as the build action hands it: the sheet offers it as an Undo.
    res.status(201).json({ run, buildable, plan: planLines(plan), undo: buildUndoStep(build.id, qty) });
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
    const ctx = tenantContext(req);
    const viewer = { userId: sessionUser(req)?.id, role: ctx.role };
    const tree = await nameGenealogy(await traceBackward(runId, genealogyLoaders(db)), (refs) => nameRecords(ctx.org.id, ctx.org.slug, refs, viewer));
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
  qty: z.number().positive().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.number().int().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  resource_label: z.string().max(120).nullable().optional(),
  notes: z.string().max(2_000).nullable().optional(),
});
const PlannedUpdate = z.object({
  qty: z.number().positive().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  priority: z.number().int().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  resource_label: z.string().max(120).nullable().optional(),
  status: z.enum(["planned", "done", "cancelled"]).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  notes: z.string().max(2_000).nullable().optional(),
});

// AI-ACTION: builds:plan-build
buildsRouter.post(
  "/planned",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:plan-build"))) return;
    const parsed = PlannedCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const build = await db.selectFrom("builds_builds").select(["id"]).where("id", "=", parsed.data.build_id).executeTakeFirst();
    if (!build) return void res.status(400).json({ error: { code: "not_found", message: "build not found" } });
    const { build_id, ...plan } = parsed.data;
    res.status(201).json(await addPlannedBuild(db, tenantContext(req).org.id, build_id, plan));
  }),
);

// AI-ACTION: builds:change-plan
buildsRouter.patch(
  "/planned/:pid",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:change-plan"))) return;
    const parsed = PlannedUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await changePlan(tenantDb(req), tenantContext(req).org.id, req.params.pid!, parsed.data);
    if (!out) return void res.status(404).json({ error: { code: "not_found", message: "planned item not found" } });
    res.json(out.row);
  }),
);

// AI-ACTION: builds:remove-plan
buildsRouter.delete(
  "/planned/:pid",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "builds:remove-plan"))) return;
    await removePlan(tenantDb(req), req.params.pid!);
    res.status(204).end();
  }),
);

// The schedule: EDD heuristic over the open (status='planned') items.
buildsRouter.get(
  "/schedule",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const ctx = tenantContext(req);
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
        "builds_planned.created_at as created_at",
        "builds_planned.assembly as assembly",
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

    // What each work order has made so far: scrap counted for its build since
    // it was planned, from the one quality record (#4053); good handed out
    // oldest order first (work-orders.ts), so two orders never share a part.
    const madeByPlan = new Map<string, { good: number; scrap: number }>();
    if (buildIds.length > 0) {
      const earliest = rows.reduce((m, r) => (new Date(r.created_at) < m ? new Date(r.created_at) : m), new Date());
      const qtys = await db
        .selectFrom("builds_op_qty")
        .select(["build_id", "kind", "quantity", "logged_at"])
        .where("build_id", "in", buildIds)
        .where("logged_at", ">=", earliest)
        .execute();
      for (const r of rows) {
        const since = new Date(r.created_at);
        let good = 0;
        let scrap = 0;
        for (const q of qtys) {
          if (q.build_id !== r.build_id || new Date(q.logged_at) < since) continue;
          if (q.kind === "good") good += Number(q.quantity) || 0;
          else if (q.kind === "scrap") scrap += Number(q.quantity) || 0;
        }
        madeByPlan.set(r.id, { good, scrap });
      }
    }

    const fifo = await madeByWorkOrder(db, buildIds);
    // Whom each work order is for, in the owning module's own words.
    const forTitle = new Map<string, { title: string; url: string | null }>();
    for (const w of fifo.values()) {
      if (!w.source_kind || !w.source_id || w.status !== "planned") continue;
      const ent = await platform().entities.lookup(ctx.org.id, w.source_kind, w.source_id).catch(() => null);
      if (ent) forTitle.set(w.id, { title: ent.title, url: ent.detailUrl ?? null });
    }
    const items: PlannedItem[] = rows.map((r) => ({
      id: r.id,
      build_id: r.build_id,
      build_name: r.build_name,
      assembly_state: r.assembly?.state ?? null,
      qty: Number(r.qty) || 1,
      due_date: r.due_date,
      priority: r.priority,
      resource_label: r.resource_label,
      est_minutes_each: estByBuild.get(r.build_id) ?? 0,
      good_qty: fifo.get(r.id)?.made ?? 0,
      source_kind: fifo.get(r.id)?.source_kind ?? null,
      source_id: fifo.get(r.id)?.source_id ?? null,
      for_title: forTitle.get(r.id)?.title ?? null,
      for_url: forTitle.get(r.id)?.url ?? null,
      scrap_qty: madeByPlan.get(r.id)?.scrap ?? 0,
    }));

    res.json(scheduleEDD(items, new Date().toISOString()));
  }),
);
