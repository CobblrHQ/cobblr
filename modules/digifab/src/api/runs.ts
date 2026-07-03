// /api/v1/orgs/:slug/modules/digifab/runs — quantity-driven production runs.
//
// CRUD only; the scheduling lives in runs-core.ts (minting, verdict counting)
// + assign-worker.ts (the drip). A run is pool + file + target_qty +
// parts_per_plate; target_qty is immutable after creation (PFM semantics) but
// completed_qty is operator-editable with reopen/close guardrails.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { kickAssign } from "../assign-worker.js";

export const runsRouter = Router({ mergeParams: true });

// GET / — runs with live coverage counts (plates in flight / queued).
runsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const runs = await db.selectFrom("digifab_production_runs").selectAll().orderBy("created_at", "desc").execute();
    const jobs = runs.length
      ? await db
          .selectFrom("digifab_jobs")
          .select(["run_id", "status", "run_outcome"])
          .where("run_id", "in", runs.map((r) => r.id))
          .execute()
      : [];
    res.json({
      items: runs.map((r) => {
        const mine = jobs.filter((j) => j.run_id === r.id);
        return {
          id: r.id,
          name: r.name,
          pool_id: r.pool_id,
          file_id: r.file_id,
          file_ref: r.file_ref,
          parts_per_plate: r.parts_per_plate,
          target_qty: r.target_qty,
          completed_qty: r.completed_qty,
          status: r.status,
          priority: r.priority,
          material_part_id: r.material_part_id,
          material_grams: r.material_grams,
          linked_build_id: r.linked_build_id,
          jobs_queued: mine.filter((j) => j.status === "queued").length,
          jobs_printing: mine.filter((j) => ["assigning", "sent", "printing"].includes(j.status)).length,
          jobs_awaiting_verdict: mine.filter((j) => j.status === "completed" && j.run_outcome == null).length,
          jobs_scrapped: mine.filter((j) => j.run_outcome === "scrapped").length,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      }),
    });
  }),
);

const RunCreate = z.object({
  name: z.string().min(1).max(160),
  pool_id: z.string().uuid(),
  file_id: z.string().min(1).optional(),
  file_ref: z.string().min(1).max(300).optional(),
  parts_per_plate: z.number().int().min(1).max(1000).default(1),
  target_qty: z.number().int().min(1).max(1_000_000),
  material_part_id: z.string().optional(),
  material_grams: z.number().positive().optional(),
  linked_build_id: z.string().optional(),
  build_qty: z.number().int().min(1).default(1),
  priority: z.number().int().min(0).max(100).default(0),
});

runsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = RunCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const b = parsed.data;
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);

    const pool = await db.selectFrom("digifab_pools").select(["id"]).where("id", "=", b.pool_id).executeTakeFirst();
    if (!pool) {
      res.status(404).json({ error: { code: "pool_not_found", message: "That pool doesn't exist." } });
      return;
    }
    // The plate file: either a stored library file (bytes upload at send) or a
    // bare routing ref. One of the two must name the file.
    let fileRef = b.file_ref ?? null;
    if (b.file_id) {
      const f = await platform().files.read(orgId, b.file_id).catch(() => null);
      if (!f) {
        res.status(404).json({ error: { code: "file_not_found", message: "That stored file doesn't exist." } });
        return;
      }
      fileRef = fileRef ?? f.filename;
    }
    if (!fileRef) {
      res.status(400).json({ error: { code: "no_file", message: "Give the run a stored file (file_id) or a file_ref." } });
      return;
    }

    const run = await db
      .insertInto("digifab_production_runs")
      .values({
        name: b.name,
        pool_id: b.pool_id,
        file_id: b.file_id ?? null,
        file_ref: fileRef,
        parts_per_plate: b.parts_per_plate,
        target_qty: b.target_qty,
        material_part_id: b.material_part_id ?? null,
        material_grams: b.material_grams != null ? String(b.material_grams) : null,
        linked_build_id: b.linked_build_id ?? null,
        build_qty: b.build_qty,
        priority: b.priority,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await kickAssign(orgId); // mint + drip immediately
    res.status(201).json({ id: run.id, status: run.status });
  }),
);

// PATCH /:id — pause / resume / cancel, and operator edits to completed_qty.
// target_qty is immutable (create a new run); status transitions are explicit.
const RunPatch = z.object({
  status: z.enum(["active", "paused", "cancelled"]).optional(),
  completed_qty: z.number().int().min(0).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

runsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = RunPatch.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const b = parsed.data;
    const orgId = tenantContext(req).org.id;
    const db = tenantDb(req);
    const run = await db.selectFrom("digifab_production_runs").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "No such run." } });
      return;
    }

    const set: Record<string, unknown> = { updated_at: new Date() };
    if (b.priority != null) set.priority = b.priority;

    if (b.completed_qty != null) {
      // Operator override with the PFM guardrail semantics: raising it past
      // target closes the run; lowering a completed run's count REOPENS it
      // (status flips back to active so minting resumes) — both explicit here,
      // no hidden state. The UI confirms before either.
      set.completed_qty = b.completed_qty;
      if (b.completed_qty >= run.target_qty) set.status = "completed";
      else if (run.status === "completed") set.status = "active";
    }
    if (b.status) {
      const effectiveCompleted = typeof set.completed_qty === "number" ? set.completed_qty : run.completed_qty;
      if (run.status === "completed" && b.status === "active" && effectiveCompleted >= run.target_qty) {
        res.status(409).json({ error: { code: "already_complete", message: "Run already hit its target — lower completed_qty to reopen." } });
        return;
      }
      set.status = b.status;
    }

    await db.updateTable("digifab_production_runs").set(set).where("id", "=", run.id).execute();

    // Cancelling (or completing via override) sweeps still-queued plates; a
    // resume kicks the worker so paused jobs dispatch again.
    const finalStatus = (set.status as string | undefined) ?? run.status;
    if (finalStatus === "cancelled" || finalStatus === "completed") {
      await db
        .updateTable("digifab_jobs")
        .set({ status: "cancelled", error: `production run ${finalStatus}`, updated_at: new Date() })
        .where("run_id", "=", run.id)
        .where("status", "=", "queued")
        .execute();
    }
    if (finalStatus === "active") await kickAssign(orgId);
    res.json({ id: run.id, status: finalStatus, completed_qty: set.completed_qty ?? run.completed_qty });
  }),
);
