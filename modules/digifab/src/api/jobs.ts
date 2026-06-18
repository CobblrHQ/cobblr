// /api/v1/orgs/:slug/modules/digifab/jobs —
// the print queue. Create a job (queued), SEND it to the farm
// (upload + place), and track it to completion.
//
// `send` is the one surface that actually starts a print on a real
// farm, so it's owner/admin only and isolated. The mock driver makes
// the whole pipeline testable without touching hardware.

import { Router } from "express";
import { z } from "zod";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { pollJob, sendJob, assignJob, buildDriverById } from "../jobs-core.js";
import { enqueuePoll } from "../poll-worker.js";

export const jobsRouter = Router({ mergeParams: true });

const JOB_COLS = [
  "id",
  "connection_id",
  "file_ref",
  "target_device",
  "target_tag",
  "target_pool",
  "material_part_id",
  "material_grams",
  "remote_file_id",
  "remote_job_id",
  "status",
  "progress",
  "error",
  "file_id",
  "linked_machine_id",
  "linked_task_id",
  "created_at",
  "updated_at",
  "last_polled_at",
] as const;

const JobCreate = z.object({
  // Optional when `target_pool` is set — a pool job is unassigned until the
  // worker picks a free member (then it stamps the connection).
  connection_id: z.string().uuid().optional(),
  file_ref: z.string().min(1).max(500),
  target_device: z.string().max(200).nullable().optional(),
  target_tag: z.string().max(200).nullable().optional(),
  target_pool: z.string().uuid().nullable().optional(),
  material_part_id: z.string().uuid().nullable().optional(),
  material_grams: z.number().positive().nullable().optional(),
  file_id: z.string().uuid().nullable().optional(),
  linked_machine_id: z.string().max(200).nullable().optional(),
  linked_task_id: z.string().max(200).nullable().optional(),
});

// F-5: cursor-paginated + status-filterable, so a busy farm's older jobs don't
// silently vanish past a hard cap. `?limit=&cursor=&status=`. cursor = the
// created_at of the last row seen (descending). Returns next_cursor when there's
// more. Back-compatible: no params → newest 100 + a cursor to load the rest.
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().datetime().optional(),
  status: z.string().max(40).optional(),
});

jobsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const { limit, cursor, status } = parsed.data;
    let q = tenantDb(req).selectFrom("digifab_jobs").select(JOB_COLS);
    if (status) q = q.where("status", "=", status);
    if (cursor) q = q.where("created_at", "<", new Date(cursor));
    const rows = await q.orderBy("created_at", "desc").limit(limit + 1).execute();
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const next_cursor = hasMore ? new Date(items[items.length - 1]!.created_at).toISOString() : null;
    res.json({ items, next_cursor });
  }),
);

jobsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = JobCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const pool = parsed.data.target_pool ?? null;
    if (!parsed.data.connection_id && !pool) {
      return void res
        .status(400)
        .json({ error: { code: "no_target", message: "a job needs a connection_id or a target_pool" } });
    }
    // A pool job is created UNASSIGNED — no connection yet (the worker stamps it).
    const row = await tenantDb(req)
      .insertInto("digifab_jobs")
      .values({
        connection_id: pool ? null : (parsed.data.connection_id ?? null),
        file_ref: parsed.data.file_ref,
        target_device: parsed.data.target_device ?? null,
        target_tag: parsed.data.target_tag ?? null,
        target_pool: pool,
        material_part_id: parsed.data.material_part_id ?? null,
        material_grams: parsed.data.material_grams != null ? String(parsed.data.material_grams) : null,
        file_id: parsed.data.file_id ?? null,
        linked_machine_id: parsed.data.linked_machine_id ?? null,
        linked_task_id: parsed.data.linked_task_id ?? null,
      })
      .returning(JOB_COLS)
      .executeTakeFirstOrThrow();
    // Drip pool jobs onto a free printer as soon as possible.
    if (pool) {
      const { kickAssign } = await import("../assign-worker.js");
      await kickAssign(tenantContext(req).org.id);
    }
    res.status(201).json(row);
  }),
);

jobsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req)
      .selectFrom("digifab_jobs")
      .select(JOB_COLS)
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    res.json(row);
  }),
);

// ── SEND — uploads + places the job on the farm. Starts a real print. ──
// The whole upload/place/persist body lives in sendJob (shared with the
// assignment worker); this route is auth + result-mapping + the poll hand-off.
jobsRouter.post(
  "/:id/send",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const r = await sendJob(tenantDb(req), ctx.org.id, req.params.id!);
    if (!r.ok) {
      const status = r.code === "already_sent" || r.code === "unknown_device" ? 409 : 404;
      const message =
        r.code === "already_sent"
          ? "job already sent"
          : r.code === "unknown_device"
            ? "target printer is not on this connection"
            : r.code === "no_connection"
              ? "connection missing"
              : "no such job";
      return void res.status(status).json({ error: { code: r.code, message } });
    }
    if (r.shouldPoll) await enqueuePoll(ctx.org.id, req.params.id!);
    res.json({ status: r.status, remote_job_id: r.remoteJobId, placement: r.placement, uploaded_bytes: r.uploadedBytes });
  }),
);

// ── re-pick a printer for an awaiting-assignment job (F-14) ──
// The job's already uploaded; this re-submits it to an explicit, validated
// device so a stuck job recovers in place instead of delete-and-recreate.
const AssignBody = z.object({ device_id: z.string().min(1).max(200) });
jobsRouter.post(
  "/:id/assign",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const r = await assignJob(tenantDb(req), ctx.org.id, req.params.id!, parsed.data.device_id);
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : 409;
      const message =
        r.code === "not_found"
          ? "no such job"
          : r.code === "not_awaiting"
            ? "job is not awaiting assignment"
            : r.code === "no_file"
              ? "job has nothing uploaded to place"
              : r.code === "unknown_device"
                ? "target printer is not on this connection"
                : "connection missing";
      return void res.status(status).json({ error: { code: r.code, message } });
    }
    if (r.shouldPoll) await enqueuePoll(ctx.org.id, req.params.id!);
    res.json({ status: r.status, remote_job_id: r.remoteJobId, placement: r.placement });
  }),
);

// ── manual poll (a "refresh status" button; the worker does this too) ──
jobsRouter.post(
  "/:id/poll",
  asyncHandler(async (req, res) => {
    const ctx = tenantContext(req);
    const result = await pollJob(tenantDb(req), ctx.org.id, req.params.id!);
    if (!result) return void res.status(409).json({ error: { code: "not_pollable", message: "job has no farm job id yet" } });
    res.json(result);
  }),
);

// ── F-4 cancel — mark a job cancelled (terminal), stopping Cobblr's tracking +
// the poll loop. Best-effort tells the manager to abort where the driver supports
// it; otherwise it's local-only (the physical print may keep running — stop it at
// the machine). Refuses to "cancel" an already-terminal job.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
jobsRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const job = await db.selectFrom("digifab_jobs").select(["id", "status", "connection_id", "remote_job_id"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!job) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if (TERMINAL_STATUSES.has(job.status)) return void res.status(409).json({ error: { code: "already_terminal", message: `job is ${job.status}` } });

    // Best-effort: ask the manager to abort if the driver + the job support it.
    let remoteCancelled = false;
    if (job.connection_id && job.remote_job_id) {
      try {
        const driver = await buildDriverById(db, ctx.org.id, job.connection_id);
        if (driver?.cancelJob) {
          await driver.cancelJob(job.remote_job_id);
          remoteCancelled = true;
        }
      } catch {
        /* best-effort — the local cancel below is the source of truth */
      }
    }
    await db.updateTable("digifab_jobs").set({ status: "cancelled", updated_at: new Date() }).where("id", "=", job.id).execute();
    res.json({ status: "cancelled", remote_cancelled: remoteCancelled });
  }),
);

// ── Cockpit live-control: pause / resume a running job at the manager. 501 when
// the driver can't (a fabrication-only / SD-card manager). ──
async function controlJob(req: import("express").Request, res: import("express").Response, action: "pause" | "resume") {
  if (!requireRole(req, res, "owner", "admin")) return;
  const ctx = tenantContext(req);
  const db = tenantDb(req);
  const job = await db.selectFrom("digifab_jobs").select(["id", "status", "connection_id", "remote_job_id"]).where("id", "=", req.params.id!).executeTakeFirst();
  if (!job) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
  if (TERMINAL_STATUSES.has(job.status)) return void res.status(409).json({ error: { code: "already_terminal", message: `job is ${job.status}` } });
  if (!job.connection_id || !job.remote_job_id) return void res.status(409).json({ error: { code: "not_running", message: "job isn't on a printer yet" } });
  const driver = await buildDriverById(db, ctx.org.id, job.connection_id);
  if (action === "pause") {
    if (!driver?.pauseJob) return void res.status(501).json({ error: { code: "unsupported", message: "this connection can't pause a job" } });
    await driver.pauseJob(job.remote_job_id);
  } else {
    if (!driver?.resumeJob) return void res.status(501).json({ error: { code: "unsupported", message: "this connection can't resume a job" } });
    await driver.resumeJob(job.remote_job_id);
  }
  const status = action === "pause" ? "paused" : "printing";
  await db.updateTable("digifab_jobs").set({ status, updated_at: new Date() }).where("id", "=", job.id).execute();
  res.json({ status });
}
jobsRouter.post("/:id/pause", asyncHandler((req, res) => controlJob(req, res, "pause")));
jobsRouter.post("/:id/resume", asyncHandler((req, res) => controlJob(req, res, "resume")));

// ── F-4 delete — remove a job from Cobblr's queue. Refuses an active job (sent/
// printing) unless it's been cancelled first, so you can't lose track of a live
// print by deleting it.
jobsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const job = await db.selectFrom("digifab_jobs").select(["id", "status"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!job) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if (job.status === "sent" || job.status === "printing") {
      return void res.status(409).json({ error: { code: "active", message: "cancel the job before deleting (it's still on a printer)" } });
    }
    await db.deleteFrom("digifab_jobs").where("id", "=", job.id).execute();
    res.status(204).end();
  }),
);
