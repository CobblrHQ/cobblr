// /api/v1/orgs/:slug/modules/core-farm/jobs —
// the print queue. Create a job (queued), SEND it to the farm
// (upload + place), and track it to completion.
//
// `send` is the one surface that actually starts a print on a real
// farm, so it's owner/admin only and isolated. The mock driver makes
// the whole pipeline testable without touching hardware.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantDb, tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { buildDriverById, pollJob } from "../jobs-core.js";
import { enqueuePoll } from "../poll-worker.js";

export const jobsRouter = Router({ mergeParams: true });

const JOB_COLS = [
  "id",
  "connection_id",
  "file_ref",
  "target_printer",
  "target_tag",
  "farm_file_id",
  "farm_job_id",
  "status",
  "progress",
  "error",
  "linked_machine_id",
  "linked_task_id",
  "created_at",
  "updated_at",
  "last_polled_at",
] as const;

const JobCreate = z.object({
  connection_id: z.string().uuid(),
  file_ref: z.string().min(1).max(500),
  target_printer: z.string().max(200).nullable().optional(),
  target_tag: z.string().max(200).nullable().optional(),
  linked_machine_id: z.string().max(200).nullable().optional(),
  linked_task_id: z.string().max(200).nullable().optional(),
});

jobsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req)
      .selectFrom("core_farm_jobs")
      .select(JOB_COLS)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    res.json({ items: rows });
  }),
);

jobsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = JobCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const row = await tenantDb(req)
      .insertInto("core_farm_jobs")
      .values({
        connection_id: parsed.data.connection_id,
        file_ref: parsed.data.file_ref,
        target_printer: parsed.data.target_printer ?? null,
        target_tag: parsed.data.target_tag ?? null,
        linked_machine_id: parsed.data.linked_machine_id ?? null,
        linked_task_id: parsed.data.linked_task_id ?? null,
      })
      .returning(JOB_COLS)
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  }),
);

jobsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req)
      .selectFrom("core_farm_jobs")
      .select(JOB_COLS)
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    res.json(row);
  }),
);

// ── SEND — uploads + places the job on the farm. Starts a real print. ──
jobsRouter.post(
  "/:id/send",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const job = await db
      .selectFrom("core_farm_jobs")
      .selectAll()
      .where("id", "=", req.params.id!)
      .executeTakeFirst();
    if (!job) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if (job.farm_job_id) return void res.status(409).json({ error: { code: "already_sent", message: "job already sent" } });

    const driver = await buildDriverById(db, ctx.org.id, job.connection_id);
    if (!driver) return void res.status(404).json({ error: { code: "no_connection", message: "connection missing" } });

    // Upload the sliced file, then place it (explicit printer, tag, or the
    // file's own routing). The bytes are a placeholder here — the real
    // gcode comes from the linked file/part in a later pass; the file_ref
    // carries the routing target meanwhile.
    const up = await driver.uploadFile(new Uint8Array(), job.file_ref);
    const sub = await driver.submitJob({
      fileId: up.fileId,
      printerId: job.target_printer,
      tag: job.target_tag,
    });

    const status = sub.queued ? "sent" : "awaiting-assignment";
    await db
      .updateTable("core_farm_jobs")
      .set({
        farm_file_id: up.fileId,
        farm_job_id: sub.jobId,
        target_printer: sub.printerId ?? job.target_printer,
        status,
        updated_at: new Date(),
      })
      .where("id", "=", req.params.id!)
      .execute();

    // Hand off to the auto-poll worker when actually queued on a printer.
    if (sub.queued && sub.jobId) await enqueuePoll(ctx.org.id, req.params.id!);
    void platform().events.emit("core-farm.job.sent", { orgId: ctx.org.id, jobId: req.params.id!, status });
    res.json({ status, farm_job_id: sub.jobId, placement: sub });
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
