import { controlCnc } from "../cnc-controls.js";
import { CncPlacementBody, placeCncProgram } from "../cnc-placement-service.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { prepareResinPrint } from "../resin-prints.js";
import { extractPlateMetadata } from "../library/extract-metadata.js";
import { controlResinPrinter } from "../resin-controls.js";
import { stopLargePrint } from "../large-format/service.js";
// /api/v1/orgs/:slug/modules/digifab/jobs —
// the print queue. Create a job (queued), SEND it to the farm
// (upload + place), and track it to completion.
//
// `send` is the one surface that actually starts a print on a real
// farm, so it's owner/admin only and isolated. The mock driver makes
// the whole pipeline testable without touching hardware.

import { sql } from "kysely";
import { isLayoutFile } from "../laser-plans.js";
import { verifyLaserOutput } from "../laser-layout.js";
import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { decodeKeysetCursor, encodeKeysetCursor } from "@cobblr/platform-contract/keyset-cursor";
import { tenantDb, tenantContext, sessionUser } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { pollJob, sendJob, assignJob, buildDriverById, reverseBuildIfCommitted, TERMINAL, markJobTerminal, managerName } from "../jobs-core.js";
import { enqueuePoll, reconcilePolls } from "../poll-worker.js";
import { JobApprovalSchema, ReviewRequired } from "../drivers/job-review.js";
import { requireLaserBedReady, stationTokenHash } from "../laser-station.js";
import { matchingLibraryMaterial } from "../laser-material.js";
import type { JobApproval } from "../drivers/types.js";
import { plainDriverError } from "../job-truth.js";

export const jobsRouter = Router({ mergeParams: true });

// AI-REACH: action digifab:place-program
// UI-SCREEN: /station/machine/:connectionId/:deviceId
jobsRouter.post("/:id/place", asyncHandler(async (req, res) => {
  // ADMIN-ONLY: placing a program on stock is setting up the machine; it stays with the admin tier, at every door (#5170)
  if (!(await requireCapability(req, res, "digifab:place-program"))) return;
  const body = CncPlacementBody.safeParse(req.body), id = z.string().uuid().safeParse(req.params.id);
  if (!body.success) return badBody(res, body.error);
  if (!id.success) return badBody(res, id.error);
  try { res.json(await placeCncProgram(tenantDb(req), tenantContext(req).org.id, id.data, body.data)); }
  catch (e) { if (!(e instanceof ReviewRequired)) throw e; res.status(409).json({ error: { code: "placement_refused", message: e.message } }); }
}));

const JOB_COLS = [
  "embroidery_run",
  "id",
  "connection_id",
  "file_ref",
  "target_device",
  "target_tag",
  "target_pool",
  "material_part_id",
  "material_grams",
  "material_type",
  "material_grams_by_tool",
  "material_drawn",
  "remote_file_id",
  "remote_job_id",
  "status",
  "priority",
  "attempts",
  "max_attempts",
  "progress",
  "eta_sec",
  "error",
  "file_id",
  "linked_machine_id",
  "linked_task_id",
  "linked_build_id",
  "build_qty",
  "build_consumed_at",
  "build_reversed_at",
  "build_output_at",
  "outcome",
  "outcome_good_qty",
  "outcome_scrap_qty",
  "outcome_at",
  "outcome_source",
  "metadata",
  "created_at",
  "updated_at",
  "last_polled_at",
] as const;

const JobCreate = z.object({
  // Optional when `target_pool` is set — a pool job is unassigned until the
  // worker picks a free member (then it stamps the connection).
  connection_id: z.string().uuid().optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  file_ref: z.string().min(1).max(500),
  target_device: z.string().max(200).nullable().optional(),
  target_tag: z.string().max(200).nullable().optional(),
  target_pool: z.string().uuid().nullable().optional(),
  material_part_id: z.string().uuid().nullable().optional(),
  material_grams: z.number().positive().nullable().optional(),
  /** The slicer's grams per filament, tool 1 first: with no spool picked,
   *  each comes off the spool loaded in that slot of the printer. */
  material_grams_by_tool: z.array(z.number().min(0).max(100000)).max(64).nullable().optional(),
  material_type: z.string().max(80).nullable().optional(),
  file_id: z.string().uuid().nullable().optional(),
  linked_machine_id: z.string().max(200).nullable().optional(),
  linked_task_id: z.string().max(200).nullable().optional(),
  /** A build (BoM) this job produces — consumed from inventory on send. */
  linked_build_id: z.string().uuid().nullable().optional(),
  build_qty: z.number().int().min(1).max(10000).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  priority: z.number().int().min(0).max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  max_attempts: z.number().int().min(1).max(10).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
});

// F-5: cursor-paginated + status-filterable, so a busy farm's older jobs don't
// silently vanish past a hard cap. `?limit=&cursor=&status=`. cursor = the
// last row seen, to the millisecond with its id (@cobblr/platform-contract/
// keyset-cursor); an older time-only cursor still reads. Returns next_cursor
// when there's more. Back-compatible: no params → newest 100 + a cursor.
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(120).refine((v) => decodeKeysetCursor(v) !== null, "not a page cursor").optional(),
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
    const c = decodeKeysetCursor(cursor);
    if (c) {
      q = c.id && /^[0-9a-f-]{36}$/i.test(c.id)
        ? q.where(sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${c.at}, ${c.id}::uuid)`)
        : q.where(sql<boolean>`date_trunc('milliseconds', created_at) < ${c.at}`);
    }
    const rows = await q.orderBy(sql`date_trunc('milliseconds', created_at)`, "desc").orderBy("id", "desc").limit(limit + 1).execute();
    const hasMore = rows.length > limit;
    const base = rows.slice(0, limit).map((r) => ({ ...r, external: false }));
    const lastRow = base[base.length - 1];
    const next_cursor = hasMore && lastRow ? encodeKeysetCursor(lastRow.created_at, lastRow.id) : null;
    // Prepend in-progress prints started ON the machine (no Cobblr job) on the
    // first page, so a running externally-started print shows in the queue. They
    // carry status 'printing' → canSend/canDelete already treat them as read-only.
    let items = base;
    if (!cursor && (!status || status === "printing")) {
      const obs = await tenantDb(req)
        .selectFrom("digifab_observed_prints")
        .select(["id", "connection_id", "serial", "file_ref", "started_at", "created_at"])
        .where("status", "=", "printing")
        .where("ended_at", "is", null)
        .orderBy("started_at", "desc")
        .execute();
      const ext = obs.map((o) => ({
        embroidery_run: false, id: o.id, connection_id: o.connection_id, file_ref: o.file_ref ?? "(started on the printer)",
        target_device: o.serial, target_tag: null, target_pool: null,
        material_part_id: null, material_grams: null, material_type: null, material_grams_by_tool: null, material_drawn: null, remote_file_id: null, remote_job_id: null,
        status: "printing", priority: 0, attempts: 0, max_attempts: 1, progress: null, eta_sec: null,
        error: null, file_id: null, linked_machine_id: null, linked_task_id: null,
        linked_build_id: null, build_qty: 1, build_consumed_at: null, build_reversed_at: null,
        outcome: null, outcome_good_qty: null, outcome_scrap_qty: null, outcome_at: null, outcome_source: null,
        build_output_deferred: false, build_output_at: null,
        created_at: o.started_at ?? o.created_at, updated_at: o.started_at ?? o.created_at,
        last_polled_at: null, metadata: {}, external: true,
      })) as typeof base;
      items = [...ext, ...base];
    }
    // Total matching rows (ignoring pagination) so the UI's count can say
    // "12 of 400", not just how many happen to be loaded.
    const totalRow = await (status
      ? tenantDb(req).selectFrom("digifab_jobs").select(({ fn }) => fn.countAll().as("n")).where("status", "=", status)
      : tenantDb(req).selectFrom("digifab_jobs").select(({ fn }) => fn.countAll().as("n"))
    ).executeTakeFirst();
    // Self-heal dead poll chains: live jobs with a remote id but nothing pending
    // on the poll queue get their polls re-enqueued (the UI refetches this route
    // every 5s while jobs are active, so recovery is near-immediate and free
    // when healthy). Detached — never slows the list response.
    const live = base.filter((j) => !TERMINAL.has(j.status) && j.remote_job_id).map((j) => j.id);
    // DETACHED: re-polling live jobs; the list is answered from the rows, and the poller runs on its own
    void reconcilePolls(tenantContext(req).org.id, live).catch(() => {});
    res.json({ items, next_cursor, total: Number(totalRow?.n ?? items.length) });
  }),
);

// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
jobsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    // Running the job is the operator's, never only the admin tier's: the page takes this step to start a job (#6785).
    if (!(await requireCapability(req, res, "digifab:operate"))) return;
    const parsed = JobCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    if (await isLayoutFile(tenantDb(req), parsed.data.file_id)) return void res.status(409).json({ error: { code: "layout_copy", message: "Use this layout's queued sheet job. Make a new plan to cut another batch." } });
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
        material_grams_by_tool: parsed.data.material_grams_by_tool?.length ? JSON.stringify(parsed.data.material_grams_by_tool) : null,
        material_type: parsed.data.material_type ?? null,
        file_id: parsed.data.file_id ?? null,
        linked_machine_id: parsed.data.linked_machine_id ?? null,
        linked_task_id: parsed.data.linked_task_id ?? null,
        linked_build_id: parsed.data.linked_build_id ?? null,
        build_qty: parsed.data.build_qty ?? 1,
        priority: parsed.data.priority ?? 0,
        max_attempts: parsed.data.max_attempts ?? 1,
      })
      .returning(JOB_COLS)
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "job_created",
      ref: { module: "digifab", entityType: "job", entityId: row.id },
      diff: { name: row.file_ref },
    });
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
    // The same labels the list resolver's rows carry, so the record page and
    // the list name a job's people and relations alike.
    const [labelled] = await platform().entities.withFieldLabels(tenantContext(req).org.id, "digifab:job", [row]);
    res.json(labelled ?? row);
  }),
);

// PATCH — re-prioritize or change the retry cap of a job (e.g. bump a queued job
// to the front). Re-kicks assignment so a freshly-prioritized pool job re-sorts now.
const JobPatch = z.object({
  priority: z.number().int().min(0).max(100).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  max_attempts: z.number().int().min(1).max(10).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  metadata: z.record(z.unknown()).optional(),
});
jobsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = JobPatch.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.priority != null) patch.priority = parsed.data.priority;
    if (parsed.data.max_attempts != null) patch.max_attempts = parsed.data.max_attempts;
    // A custom field saved on its own merges into what the job holds.
    if (parsed.data.metadata !== undefined) patch.metadata = platform().db.mergeJsonb("metadata", parsed.data.metadata);
    const row = await tenantDb(req).updateTable("digifab_jobs").set(patch).where("id", "=", req.params.id!).returning(JOB_COLS).executeTakeFirst();
    if (!row) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if (parsed.data.priority != null && row.target_pool && row.status === "queued") {
      const { kickAssign } = await import("../assign-worker.js");
      await kickAssign(tenantContext(req).org.id);
    }
    res.json(row);
  }),
);

// UI-REACH: the job review sheet loads the project before an owner approves Start.
// AI-REACH: exempt the interactive Start review before a send; physical sends use digifab:send.
jobsRouter.post("/:id/prepare", asyncHandler(async (req, res) => {
  // Send's review on the page, so whoever may send may review (#6785).
  if (!(await requireCapability(req, res, "digifab:operate"))) return;
  const db = tenantDb(req);
  const orgId = tenantContext(req).org.id;
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
  if (!job) return void res.status(404).json({ error: { code: "not_found", message: "No such job." } });
  if (job.status !== "queued" || job.remote_job_id || job.send_token || job.target_pool || !job.connection_id) return void res.status(409).json({ error: { code: "not_ready", message: "Choose a queued job on one connection to review." } });
  const driver = await buildDriverById(db, orgId, job.connection_id);
  if (!driver || !await driver.jobReviewRequired?.()) return void res.json({ review: null });
  const stationToken = typeof req.body?.stationToken === "string" ? req.body.stationToken : "";
  const station = stationToken && job.target_device ? await db.selectFrom("digifab_stations").select("id").where("token_hash", "=", stationTokenHash(stationToken)).where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device).where("revoked_at", "is", null).executeTakeFirst() : null;
  if (!station) return void res.json({ review: null, stationRequired: { connectionId: job.connection_id, deviceId: job.target_device } });
  if (!driver.prepareJob || !job.file_id) return void res.status(409).json({ error: { code: "file_required", message: "Choose a stored file to prepare this job." } });
  const file = await platform().files.read(orgId, job.file_id);
  if (!file) return void res.status(409).json({ error: { code: "file_missing", message: "The job's stored file no longer exists." } });
  const reviewKind = await driver.jobReviewKind?.();
  const print = reviewKind === "print", cnc = reviewKind === "cnc", cutter = reviewKind === "cutter";
  const preparedFile = cnc ? /\.(nc|gcode|tap)$/i : cutter ? /\.cutterplan$/i : driver.printProcess === "large-format" ? /\.ippplan$/i : driver.printProcess === "resin" ? /\.goo$/i : print ? /\.(gcode|gco)$/i : driver.laserBackend ? /\.laserplan$/i : /\.lbrn2$/i;
  if (!preparedFile.test(file.filename)) return void res.status(409).json({ error: { code: "prepared_file_required", message: cnc ? "Choose a posted CNC program for this station." : cutter ? "Choose a prepared cutter file for this station." : driver.printProcess === "resin" ? "Choose a sliced GOO resin print for this station." : print ? "Choose a sliced G-code print for this station." : "Choose a prepared laser file for this station." } });
  try {
    await requireLaserBedReady(db, job);
    const devices = await driver.listDevices();
    const device = devices.find(d => d.id === job.target_device);
    if (!device || ["running", "printing", "paused", "busy"].includes(device.state ?? "")) throw new Error("This machine is busy. Finish its current job before loading another file.");
    if (driver.laserBackend || cnc || cutter || ["resin", "large-format"].includes(driver.printProcess ?? "")) await db.updateTable("digifab_jobs").set({ cancel_requested_at: null }).where("id", "=", job.id).where("send_token", "is", null).execute();
    const review = await driver.prepareJob(new Uint8Array(file.bytes), file.filename);
    if (driver.printProcess === "resin") {
      if (!job.target_device) throw new Error("Choose this resin printer before reviewing the print.");
      const seconds = typeof device.raw?.PrintScreen === "number" ? device.raw.PrintScreen : undefined;
      await prepareResinPrint(db, orgId, job.id, job.connection_id, job.target_device, review.fileId, extractPlateMetadata(file.filename, Buffer.from(file.bytes)), seconds);
      await db.updateTable("digifab_jobs").set({ resin_print: true }).where("id", "=", job.id).execute();
    }
    const layout = job.laser_layout;
    if (layout) {
      verifyLaserOutput(layout.expected, review);
      if (review.contentHash !== layout.content_hash) throw new Error("The queued layout file changed. Make a new plan.");
    }
    res.json({ review: { ...review, sourceFile: { id: job.file_id, filename: file.filename }, materialSuggestion: (review.project.units as { distance?: string } | undefined)?.distance === "mm" ? matchingLibraryMaterial(review.cuts, review.materialLibrary) : null } });
  }
  catch (e) {
    const detail = String(e instanceof Error ? e.message : e);
    res.status(print ? 409 : 502).json({ error: { code: "prepare_failed", message: !print && !cnc && /import|timeout|modal|unsaved/i.test(detail) ? "LightBurn needs attention on its screen. Check for a prompt, then try preparing the job again." : plainDriverError(e, await managerName(orgId, job.connection_id), "preparing the project") } });
  }
}));

// ── SEND — uploads + places the job on the farm. Starts a real print. ──
// The whole upload/place/persist body lives in sendJob (shared with the
// assignment worker); this route is auth + result-mapping + the poll hand-off.
// AI-ACTION: digifab:send
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
jobsRouter.post(
  "/:id/send",
  asyncHandler(async (req, res) => {
    // The admin tier, or an operator: the action's own gate, at every door (#6672).
    if (!(await requireCapability(req, res, "digifab:send"))) return;
    const ctx = tenantContext(req);
    const body = z.object({ approval: JobApprovalSchema.optional() }).safeParse(req.body ?? {});
    if (!body.success) return void badBody(res, body.error);
    const r = await sendAndWatch(tenantDb(req), ctx.org.id, req.params.id!, body.data.approval);
    if (!r.ok) {
      if (r.code === "send_failed") return void res.status(502).json({ error: { code: r.code, message: r.message } });
      return void res.status(r.code === "not_found" ? 404 : 409).json({ error: { code: r.code, message: r.message } });
    }
    res.json({ status: r.status, remote_job_id: r.remoteJobId, placement: r.placement, uploaded_bytes: r.uploadedBytes });
  }),
);

const SEND_REFUSALS: Record<string, string> = {
  batch_approval_required: "Start this print from its batch card so its approval and bed check are recorded.",
  review_required: "Review this job in the queue and approve Start first.",
  already_sent: "job already sent",
  already_sending: "This job is already being sent to its printer.",
  already_terminal: "job already finished — use retry",
  unknown_device: "target printer is not on this connection",
  file_missing: "the job's stored file no longer exists",
  no_connection: "connection missing",
  not_found: "no such job",
};

/** Send a job to its machine and start watching it: the ONE send, behind the
 *  page's button (the route above) and the digifab:send action alike, so the
 *  action's physical effect is the only way a job reaches a machine (Services
 *  §9, §14.3). */
export async function sendAndWatch(db: Parameters<typeof sendJob>[0], orgId: string, jobId: string, approval?: JobApproval, batchPermit?: import("../batch-start-permit.js").BatchStartPermit) {
  const r = await sendJob(db, orgId, jobId, approval, batchPermit);
  if (!r.ok) {
    if(r.code==="send_failed"&&r.shouldPoll)await enqueuePoll(orgId,jobId);
    // A refusal that carries its own sentence says it; the table covers the rest.
    const message = "message" in r ? r.message : (SEND_REFUSALS[r.code] ?? "no such job");
    return { ok: false as const, code: r.code, message };
  }
  if (r.shouldPoll) await enqueuePoll(orgId, jobId);
  return r;
}

/** digifab:send: the action that starts a machine. Declared `effect:
 *  physical`, so a person's yes stands in front of it from every door (an
 *  assistant, a wire, module code), not only the page's dialog. */
export function registerSendAction(): void {
  platform().actions.registerHandler("digifab.send", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const jobId = typeof a.job_id === "string" && a.job_id ? a.job_id : ctx.entity?.kind === "digifab:job" ? ctx.entity.id : null;
    if (!jobId) return { ok: false, error: "which job to send is needed (job_id)" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Parameters<typeof sendJob>[0];
    const approved = JobApprovalSchema.safeParse(a.approval);
    const r = await sendAndWatch(db, ctx.orgId, jobId, approved.success ? approved.data : undefined);
    if (!r.ok) return { ok: false, error: r.message, code: r.code };
    return { ok: true, job_id: jobId, status: r.status, remote_job_id: r.remoteJobId };
  });
}

// ── re-pick a printer for an awaiting-assignment job (F-14) ──
// The job's already uploaded; this re-submits it to an explicit, validated
// device so a stuck job recovers in place instead of delete-and-recreate.
const AssignBody = z.object({ device_id: z.string().min(1).max(200) });
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
jobsRouter.post(
  "/:id/assign",
  asyncHandler(async (req, res) => {
    // Running the job is the operator's, never only the admin tier's: the page takes this step to start a job (#6785).
    if (!(await requireCapability(req, res, "digifab:operate"))) return;
    const parsed = AssignBody.safeParse(req.body);
    if (!parsed.success) return void badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const r = await assignJob(tenantDb(req), ctx.org.id, req.params.id!, parsed.data.device_id);
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : 409;
      const message =
        "message" in r ? r.message : r.code === "not_found"
          ? "no such job"
          : r.code === "batch_approval_required"
            ? "Start this print from its batch card so its approval and bed check are recorded."
          : r.code === "not_awaiting"
            ? "job is not awaiting assignment"
            : r.code === "no_file"
              ? "job has nothing uploaded to place"
              : r.code === "unknown_device"
                ? "target printer is not on this connection"
                : r.code === "already_sending"
                  ? "This job is already being sent to its printer."
                  : "connection missing";
      return void res.status(status).json({ error: { code: r.code, message } });
    }
    if (r.shouldPoll) await enqueuePoll(ctx.org.id, req.params.id!);
    res.json({ status: r.status, remote_job_id: r.remoteJobId, placement: r.placement });
  }),
);

// ── RETRY — explicitly re-queue a terminal failed/cancelled job and send it
// again. The deliberate path back from terminal (sendJob itself refuses terminal
// statuses): resets the remote ids + error, then reuses the normal send/assign
// machinery. A pool job goes back to the pool. The build link's consumed/reversed
// stamps reset together: the fail/cancel already reversed the commit, so the
// fresh send commits the materials again — one net commit per successful run.
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
jobsRouter.post(
  "/:id/retry",
  asyncHandler(async (req, res) => {
    // Running the job is the operator's, never only the admin tier's: the page takes this step to start a job (#6785).
    if (!(await requireCapability(req, res, "digifab:operate"))) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const job = await db.selectFrom("digifab_jobs").select(["id", "status", "target_pool", "cnc_setup", "cnc_usage_recorded_at", "embroidery_run", "make_ordinal"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!job) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if (job.make_ordinal != null) return void res.status(409).json({ error: { code: "batch_approval_required", message: "Use the batch card for this print. To print another batch, prepare it in Makes." } });
    if (job.embroidery_run) return void res.status(409).json({ error: { code: "embroidery_station_required", message: "Prepare a new embroidery run or record this run at its embroidery station." } });
    if (job.status !== "failed" && job.status !== "cancelled") {
      return void res.status(409).json({ error: { code: "not_retryable", message: "only a failed or cancelled job can be retried" } });
    }
    if(job.cnc_setup&&!job.cnc_usage_recorded_at)return void res.status(409).json({error:{code:"stock_use_pending",message:"Record this CNC attempt's stock use and outcome at the station first."}});
    // A build whose consumption was reversed can commit again on this send.
    // Conditional on the job still being failed or cancelled: two retries at
    // once must not both re-queue it (the second would wipe the first's send
    // and print the job again).
    const requeued = await db
      .updateTable("digifab_jobs")
      .set({
        status: "queued",
        send_token: null,
        send_claimed_at: null,
        remote_job_id: null,
        remote_file_id: null,
        progress: 0,
        error: null,
        poll_errors: 0,
        build_consumed_at: null,
        build_reversed_at: null,
        // A retried job is judged afresh: the failed attempt's scrap is in the
        // event history, and the next plate gets its own verdict.
        build_output_deferred: false,
        build_output_at: null,
        outcome: null,
        outcome_good_qty: null,
        outcome_scrap_qty: null,
        outcome_at: null,
        outcome_source: null,
        ...(job.target_pool ? { connection_id: null, target_device: null } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", job.id)
      .where("status", "in", ["failed", "cancelled"])
      .executeTakeFirst();
    if (Number(requeued.numUpdatedRows ?? 0n) === 0) {
      return void res.status(409).json({ error: { code: "already_retried", message: "This job is already being retried." } });
    }
    if (job.target_pool) {
      const { kickAssign } = await import("../assign-worker.js");
      await kickAssign(ctx.org.id);
      return void res.json({ status: "queued", pooled: true });
    }
    const r = await sendAndWatch(db, ctx.org.id, job.id);
    if (!r.ok) {
      // Left queued — the user can fix the cause and Send manually.
      return void res.json({ status: "queued", sent: false, reason: r.code });
    }
    res.json({ status: r.status, sent: true, remote_job_id: r.remoteJobId });
  }),
);

/** Within this long, the same person reprinting the same job again is asked first. */
const REPRINT_AGAIN_MS = 10_000;

// ── REPRINT — "print this again": CLONE a (typically completed) job into a
// fresh queued one and send it. Distinct from retry (which re-runs the SAME
// terminal-failed row in place): the source job's history stays untouched, and
// the clone carries everything that made the print reproducible — file, routing,
// material draw, build link (fresh commit stamps), priority, retry cap.
// AI-REACH: sends work to a physical machine through its manager; run-command is the one deliberate door
jobsRouter.post(
  "/:id/reprint",
  asyncHandler(async (req, res) => {
    // Running the job is the operator's, never only the admin tier's: the page takes this step to start a job (#6785).
    if (!(await requireCapability(req, res, "digifab:operate"))) return;
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const src = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", req.params.id!).executeTakeFirst();
    if (!src) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if (src.make_ordinal != null) return void res.status(409).json({ error: { code: "batch_approval_required", message: "Use the batch card for this print. To print another batch, prepare it in Makes." } });
    if (src.embroidery_run) return void res.status(409).json({ error: { code: "embroidery_station_required", message: "Prepare a new embroidery run with its hoop and thread choices." } });
    // A double tap is almost never "two copies, please", and a print is
    // physical. The stamp is one conditional UPDATE, so two taps at once
    // cannot both pass; the second is asked, and `again: true` is the
    // deliberate second copy.
    const again = (req.body as { again?: unknown } | undefined)?.again === true;
    const userId = sessionUser(req)?.id ?? null;
    const now = new Date();
    const stamp = db.updateTable("digifab_jobs").set({ last_reprint_at: now, last_reprint_by: userId }).where("id", "=", src.id);
    const stamped = again
      ? await stamp.executeTakeFirst()
      : await stamp
          .where(({ or, eb }) =>
            or([
              eb("last_reprint_at", "is", null),
              eb("last_reprint_at", "<", new Date(now.getTime() - REPRINT_AGAIN_MS)),
              sql<boolean>`(last_reprint_by is distinct from ${userId}::uuid)`,
            ]),
          )
          .executeTakeFirst();
    if (Number(stamped.numUpdatedRows ?? 0n) === 0) {
      return void res.status(409).json({ error: { code: "just_reprinted", message: "You just reprinted this. Print another copy?" } });
    }
    // check-then-insert: The stamp serializes requests; clones get generated ids with no batch ordinal.
    const clone = await db
      .insertInto("digifab_jobs")
      .values({
        connection_id: src.target_pool ? null : src.connection_id,
        file_ref: src.file_ref,
        target_device: src.target_pool ? null : src.target_device,
        target_tag: src.target_tag,
        target_pool: src.target_pool,
        material_part_id: src.material_part_id,
        material_grams: src.material_grams,
        material_grams_by_tool: src.material_grams_by_tool == null ? null : JSON.stringify(src.material_grams_by_tool),
        material_type: src.material_type,
        file_id: src.file_id,
        linked_machine_id: src.linked_machine_id,
        linked_task_id: src.linked_task_id,
        linked_build_id: src.linked_build_id,
        build_qty: src.build_qty,
        priority: src.priority,
        max_attempts: src.max_attempts,
      })
      .returning(JOB_COLS)
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: tenantContext(req).org.id,
      userId: sessionUser(req)?.id ?? null,
      action: "job_created",
      ref: { module: "digifab", entityType: "job", entityId: clone.id },
      diff: { name: clone.file_ref, cloned_from: src.id },
    });
    if (src.target_pool) {
      const { kickAssign } = await import("../assign-worker.js");
      await kickAssign(ctx.org.id);
      return void res.json({ job: clone, status: "queued", pooled: true });
    }
    const r = await sendAndWatch(db, ctx.org.id, clone.id);
    if (!r.ok) {
      // Clone stays queued (e.g. its stored file was deleted) — visible in the
      // queue with the reason, sendable manually once fixed.
      return void res.json({ job: clone, status: "queued", sent: false, reason: r.code });
    }
    res.json({ job: clone, status: r.status, sent: true, remote_job_id: r.remoteJobId });
  }),
);

// ── manual poll (a "refresh status" button; the worker does this too) ──
// Mutates job state (status/progress/attention), so it takes the same roles as
// the other job mutations — it was unauthenticated-role before the audit.
jobsRouter.post(
  "/:id/poll",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
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
/** What a request to change a job came back with, for a route to send and an
 *  action to say. */
export interface JobReply { status: number; body: Record<string, unknown> }
const reply = (status: number, body: Record<string, unknown>): JobReply => ({ status, body });

/** Cancel a job: the page's Cancel and the assistant's Stop are this one call
 *  (#5091). It stops the machine where the job runs, and is real only when the
 *  machine says it stopped. */
export async function cancelJob(db: ReturnType<typeof tenantDb>, orgId: string, jobId: string): Promise<JobReply> {
    const job = await db.selectFrom("digifab_jobs").select(["id", "status", "connection_id", "remote_job_id", "target_device", "send_token", "embroidery_run"]).where("id", "=", jobId).executeTakeFirst();
    if (!job) return reply(404, { error: { code: "not_found", message: "no such job" } });
    if (job.embroidery_run) return reply(409, { error: { code: "embroidery_station_required", message: "Stop the physical embroidery machine using its own controls, then record the interruption and measured thread use at its embroidery station." } });
    if (TERMINAL.has(job.status)) return reply(409, { error: { code: "already_terminal", message: `job is ${job.status}` } });

    if(job.send_token && job.connection_id && job.target_device && !job.remote_job_id){
      const driver=await buildDriverById(db,orgId,job.connection_id);
      if(await driver?.jobReviewKind?.()==="cnc"){
        const result=await controlCnc(db,orgId,driver!,job.target_device,"stop",{},job.connection_id);
        if(!result.ok)return reply(502, {error:{code:"cancel_failed",message:result.detail??"The CNC controller has not confirmed Stop. Check the machine."}});
        return reply(202, {status:job.status,cancelling:true,remote_cancelled:false,message:"Stop requested during Start. Waiting for the CNC controller to confirm."});
      }
    }

    const printDriver = job.connection_id ? await buildDriverById(db, orgId, job.connection_id) : null;
    if ((printDriver?.printProcess === "resin" || printDriver?.printProcess === "large-format") && job.target_device && job.connection_id) {
      try {
        const result = printDriver.printProcess === "large-format"
          ? await stopLargePrint(db, orgId, {connection_id:job.connection_id,device_id:job.target_device})
          : await controlResinPrinter(db, orgId, printDriver, job.target_device, "stop", job.connection_id);
        if (!result.ok) return reply(502, { error: { code: "cancel_failed", message: result.detail ?? "The printer did not confirm Stop." } });
      } catch (e) {
        return reply(502, { error: { code: "cancel_failed", message: plainDriverError(e, "the printer", "stopping the print") } });
      }
      const now = await db.selectFrom("digifab_jobs").select("status").where("id", "=", job.id).executeTakeFirst();
      if (job.remote_job_id && now?.status !== "cancelled") await enqueuePoll(orgId, job.id);
      return reply(now?.status === "cancelled" ? 200 : 202, { status: now?.status ?? job.status, remote_cancelled: now?.status === "cancelled", cancelling: now?.status !== "cancelled", message: "Stop sent. The printer's status confirms when it has stopped." });
    }

    // Not on a printer yet (queued, or sent with no id to track): there is
    // nothing physical to stop, so the cancel is Cobblr's alone.
    if (!job.connection_id || !job.remote_job_id) {
      await markJobTerminal(db, job, "cancelled");
      await reverseBuildIfCommitted(db, orgId, job.id, "print cancelled");
      return reply(200, { status: "cancelled", remote_cancelled: false });
    }

    // On a printer: the cancel is real only when the printer says it stopped.
    // It used to be marked Cancelled whatever happened, so on a manager that
    // cannot cancel (PrusaLink, FDM Monster) the job read Cancelled while the
    // printer kept printing, and someone walked away from a running print.
    const manager = await managerName(orgId, job.connection_id);
    const driver = await buildDriverById(db, orgId, job.connection_id);
    if (!driver?.cancelJob) {
      return reply(501, {
        error: {
          code: "cannot_cancel",
          message: `${manager} can't stop a print from Cobblr. Stop it at the printer; Cobblr will see it stop.`,
        },
      });
    }
    try {
      await driver.cancelJob(job.remote_job_id);
    } catch (e) {
      return reply(502, { error: { code: "cancel_failed", message: plainDriverError(e, manager, "cancelling the print") } });
    }
    await db.updateTable("digifab_jobs").set({ cancel_requested_at: new Date(), updated_at: new Date() }).where("id", "=", job.id).execute();
    // Ask straight away: most managers stop within the request. What the
    // printer answers decides, through the same rule every poll uses.
    const polled = await pollJob(db, orgId, job.id).catch(() => null);
    const now = await db.selectFrom("digifab_jobs").select(["status", "error"]).where("id", "=", job.id).executeTakeFirst();
    if (now?.status === "cancelled") {
      await reverseBuildIfCommitted(db, orgId, job.id, "print cancelled");
      return reply(200, { status: "cancelled", remote_cancelled: true });
    }
    // Still going: the poll chain finishes the cancel when the printer stops.
    if (polled && !polled.terminal) await enqueuePoll(orgId, job.id);
    return reply(202, { status: now?.status ?? job.status, remote_cancelled: false, cancelling: true, message: "Cancel sent; waiting for the printer to stop." });
}

// AI-ACTION: digifab:stop
jobsRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "digifab:stop"))) return;
    const out = await cancelJob(tenantDb(req), tenantContext(req).org.id, req.params.id!);
    res.status(out.status).json(out.body);
  }),
);

// ── Cockpit live-control: pause / resume a running job at the manager. 501 when
// the driver can't (a fabrication-only / SD-card manager). ──
/** Pause or resume a running job at its manager. Pause is also the
 *  assistant's Stop with pause (#5091); resume is the page's alone. */
export async function controlJobById(db: ReturnType<typeof tenantDb>, orgId: string, jobId: string, action: "pause" | "resume"): Promise<JobReply> {
  const job = await db.selectFrom("digifab_jobs").select(["id", "status", "connection_id", "remote_job_id"]).where("id", "=", jobId).executeTakeFirst();
  if (!job) return reply(404, { error: { code: "not_found", message: "no such job" } });
  if (TERMINAL.has(job.status)) return reply(409, { error: { code: "already_terminal", message: `job is ${job.status}` } });
  if (!job.connection_id || !job.remote_job_id) return reply(409, { error: { code: "not_running", message: "job isn't on a printer yet" } });
  const driver = await buildDriverById(db, orgId, job.connection_id);
  const manager = await managerName(orgId, job.connection_id);
  if (action === "pause") {
    if (!driver?.pauseJob) return reply(501, { error: { code: "unsupported", message: `${manager} can't pause a print from Cobblr. Pause it at the printer.` } });
  } else if (!driver?.resumeJob) {
    return reply(501, { error: { code: "unsupported", message: `${manager} can't resume a print from Cobblr. Resume it at the printer.` } });
  }
  try {
    if (action === "pause") await driver!.pauseJob!(job.remote_job_id);
    else await driver!.resumeJob!(job.remote_job_id);
  } catch (e) {
    return reply(502, { error: { code: `${action}_failed`, message: plainDriverError(e, manager, action === "pause" ? "pausing the print" : "resuming the print") } });
  }
  const status = action === "pause" ? "paused" : "printing";
  await db.updateTable("digifab_jobs").set({ status, updated_at: new Date() }).where("id", "=", job.id).execute();
  return reply(200, { status });
}
async function controlJob(req: import("express").Request, res: import("express").Response, action: "pause" | "resume", gate = true) {
  // Pause is the assistant's Stop: its route gates on digifab:stop (#5170);
  // resume is the page's alone: the admin tier, or an operator (#6672).
  if (gate && !(await requireCapability(req, res, "digifab:operate"))) return;
  const out = await controlJobById(tenantDb(req), tenantContext(req).org.id, req.params.id!, action);
  res.status(out.status).json(out.body);
}
// AI-ACTION: digifab:stop
jobsRouter.post("/:id/pause", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:stop"))) return;
  await controlJob(req, res, "pause", false);
}));
// AI-REACH: exempt resuming starts a machine again; a person presses it at the page, where it is confirmed

jobsRouter.post("/:id/resume", asyncHandler((req, res) => controlJob(req, res, "resume")));

// ── F-4 delete — remove a job from Cobblr's queue. Refuses an active job (sent/
// printing) unless it's been cancelled first, so you can't lose track of a live
// print by deleting it.
jobsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const job = await db.selectFrom("digifab_jobs").select(["id", "status", "cnc_setup", "cnc_usage_recorded_at", "embroidery_run"]).where("id", "=", req.params.id!).executeTakeFirst();
    if (!job) return void res.status(404).json({ error: { code: "not_found", message: "no such job" } });
    if(job.cnc_setup&&!job.cnc_usage_recorded_at)return void res.status(409).json({error:{code:"stock_use_pending",message:"Record this CNC attempt's stock use and outcome at the station first."}});
    if (job.embroidery_run) return void res.status(409).json({ error: { code: "embroidery_station_required", message: "Prepare a new embroidery run or record this run at its embroidery station." } });
    // `paused` is physically mid-print too, and an `unknown`-status job may be —
    // anything that isn't locally terminal or pre-send must be cancelled first,
    // so a live print can't silently vanish from tracking.
    if (!["queued", "awaiting-assignment", "completed", "failed", "cancelled"].includes(job.status)) {
      return void res.status(409).json({ error: { code: "active", message: "cancel the job before deleting (it may still be on a printer)" } });
    }
    await db.deleteFrom("digifab_jobs").where("id", "=", job.id).execute();
    res.status(204).end();
  }),
);
