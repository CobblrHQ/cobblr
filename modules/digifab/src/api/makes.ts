// /api/v1/orgs/:slug/modules/digifab/makes — Makes (services.md §13).
//
// A Make is one fabrication run, request to outcome. Its steps are recorded
// by whatever did them (a person, a service job, an upload, a send) and read
// back as one timeline, whose shape (placeholders, or an honest end with a
// door) comes from makes-core.ts.

import { Router, type Request } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { z } from "zod";
import { likeEscape, platform } from "@cobblr/platform-contract";
import { readFilamentDrawn, readGramsByTool } from "@cobblr/platform-contract/filament-draw";
import { pagedAnswer, readListPage, TOTAL_COLUMN, MAX_PAGE } from "@cobblr/platform-contract/list-page";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import type { DigifabDB } from "../db.js";
import { sql, type Kysely } from "kysely";
import { asyncHandler, badBody, requireRole } from "./util.js";
import {
  BatchPrintStepOwnedError,
  FILE_ROLES,
  MAKE_KIND,
  MAKE_STEPS,
  REL_PRINTED_AS,
  REL_PRINTED_ON,
  REL_USED,
  REL_MADE_FOR,
  attachToStep,
  emitMakeCompleted,
  spoolsFromJob,
  isMakeStep,
  reachFor,
  recordMakeStep,
  timelineFor,
  type MakeStep,
  type StepRow,
  type StepWrite,
} from "../makes-core.js";
import { requireFamilyPrinting } from "../core/families.js";

export const makesRouter = Router({ mergeParams: true });

const Step = z.enum(MAKE_STEPS);
const FileRef = z.object({ file_id: z.string().min(1), role: z.enum(FILE_ROLES).default("other") });

type MakeRow = Awaited<ReturnType<typeof loadMake>>;

async function loadMake(db: Kysely<DigifabDB>, id: string) {
  return db.selectFrom("digifab_makes").selectAll().where("id", "=", id).executeTakeFirst();
}

async function stepsOf(db: Kysely<DigifabDB>, makeId: string): Promise<StepRow[]> {
  const rows = await db.selectFrom("digifab_make_steps").selectAll().where("make_id", "=", makeId).execute();
  return rows
    .filter((r) => isMakeStep(r.step))
    .map((r) => ({ ...r, step: r.step as MakeStep, status: r.status as StepRow["status"] }))
    .sort((a, b) => MAKE_STEPS.indexOf(a.step) - MAKE_STEPS.indexOf(b.step));
}

/** Who is writing, in which workspace: a request's, or an action's. */
export interface MakeCtx {
  db: Kysely<DigifabDB>;
  orgId: string;
  userId: string | null;
}

const ctxOf = (req: Request): MakeCtx => ({ db: tenantDb(req), orgId: tenantContext(req).org.id, userId: sessionUser(req)?.id ?? null });

/** Record (or replace) one step of a Make: the routes' and actions' door to
 *  recordMakeStep, which every writer shares. */
async function recordStep(ctx: MakeCtx, make: NonNullable<MakeRow>, step: MakeStep, body: StepWrite): Promise<string> {
  return recordMakeStep(ctx.db, ctx.orgId, ctx.userId, make, step, body);
}

/** The files on each step, from core-files' attachments. */
async function filesOf(orgId: string, stepIds: string[]) {
  const out: Record<string, Array<{ id: string; file_id: string; role: string | null; filename: string; mime_type: string; kind: string }>> = {};
  for (const id of stepIds) {
    const rows = (await platform().files.listAttachments(orgId, { source_module: "digifab", source_type: "make-step", source_id: id })) ?? [];
    out[id] = rows.map((r) => ({
      id: r.id,
      file_id: r.fileId,
      role: r.role,
      filename: r.filename,
      mime_type: r.mimeType,
      kind: r.kind,
    }));
  }
  return out;
}

// ── list + search ──────────────────────────────────────────────────────────

export async function listMakes(db: Kysely<DigifabDB>, q: string | undefined, limit: number, offset: number) {
  let query = db.selectFrom("digifab_makes").selectAll();
  const text = q?.trim();
  if (text) {
    const like = `%${likeEscape(text)}%`;
    query = query.where((eb) =>
      eb.or([
        eb("name", "ilike", like),
        eb("prompt", "ilike", like),
        eb("printer_name", "ilike", like),
        eb("material", "ilike", like),
        eb("outcome", "ilike", like),
      ]),
    );
  }
  const rows = await query.orderBy("created_at", "desc").limit(limit).offset(offset).execute();
  const ids = rows.map((r) => r.id);
  const steps = ids.length
    ? await db.selectFrom("digifab_make_steps").select(["make_id", "step", "status"]).where("make_id", "in", ids).execute()
    : [];
  return rows.map((r) => {
    const mine = steps.filter((s) => s.make_id === r.id).sort((a, b) => MAKE_STEPS.indexOf(a.step as MakeStep) - MAKE_STEPS.indexOf(b.step as MakeStep));
    const last = mine[mine.length - 1] ?? null;
    return { ...r, last_step: last ? { step: last.step, status: last.status } : null };
  });
}

makesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json({ items: await listMakes(tenantDb(req), q, limit, offset) });
  }),
);

// ── start a Make ───────────────────────────────────────────────────────────

export interface StartMake {
  name: string;
  prompt?: string;
  origin?: "page" | "cobb" | "mcp" | "module";
  start_at?: "request" | "model" | "slice";
  files?: Array<{ file_id: string; role: (typeof FILE_ROLES)[number] }>;
  /** What this Make is for (an order line, a work order): linked both ways,
   *  and carried on the Make's completion. */
  source?: { kind: string; id: string };
}

/** Start a Make: the one door, for the route and for the action other
 *  modules call. A request starts at the request; your own file starts at the
 *  step it is (an STL is the Model, G-code is the Slice). */
export async function startMake(ctx: MakeCtx, b: StartMake) {
  const startAt = b.start_at ?? "request";
  const made = await ctx.db
    .insertInto("digifab_makes")
    .values({
      name: b.name,
      prompt: b.prompt ?? null,
      start_step: startAt,
      created_by: ctx.userId,
      source_kind: b.source?.kind ?? null,
      source_id: b.source?.id ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (startAt === "request") {
    await recordStep(ctx, made, "request", {
      data: { prompt: b.prompt, origin: b.origin ?? "page", requested_by: ctx.userId, requested_at: new Date().toISOString() },
      produced_by: { kind: "person" },
      files: b.files,
    });
  } else {
    await recordStep(ctx, made, startAt, { data: { source: "uploaded" }, produced_by: { kind: "upload" }, files: b.files });
  }
  if (b.source) {
    await platform().pairings.create({
      orgId: ctx.orgId,
      sourceKind: MAKE_KIND,
      sourceId: made.id,
      targetKind: b.source.kind,
      targetId: b.source.id,
      relationshipKind: REL_MADE_FOR,
      createdBy: ctx.userId,
    });
  }
  await platform().activity.log({ orgId: ctx.orgId, userId: ctx.userId, action: "make_created", ref: { module: "digifab", entityType: "make", entityId: made.id }, diff: { name: made.name } });
  await platform().events.emit("digifab.make.created", { orgId: ctx.orgId, makeId: made.id, ...(b.source ? { source: b.source } : {}) });
  return made;
}

const MakeCreate = z
  .object({
    name: z.string().trim().min(1).max(200),
    /** What to make, in words: a Make that starts at the request. */
    prompt: z.string().trim().min(1).max(8000).optional(),
    /** Where a person asked from. */
    origin: z.enum(["page", "cobb", "mcp"]).default("page"),
    /** What it is for: an order line, a work order. */
    source: z.object({ kind: z.string().min(1).max(200), id: z.string().min(1).max(200) }).optional(),
    /** Start midway: at Model with your own STL/STEP/3MF, or at Slice with
     *  your own G-code. */
    start_at: z.enum(["request", "model", "slice"]).default("request"),
    files: z.array(FileRef).max(20).optional(),
    /** Run another Make again from one of its steps. */
    rerun_of: z.string().uuid().optional(),
    from_step: z.enum(["design", "model", "slice", "print"]).optional(),
  })
  .refine((b) => !b.rerun_of || !!b.from_step, { message: "a re-run says which step it runs again from", path: ["from_step"] })
  .refine((b) => !!b.rerun_of || b.start_at !== "request" || !!b.prompt, { message: "a Make that starts at the request needs the request", path: ["prompt"] })
  .refine((b) => !!b.rerun_of || b.start_at === "request" || (b.files?.length ?? 0) > 0, { message: "a Make that starts midway needs its file", path: ["files"] });

// AI-REACH: crud — the digifab:make kind's create
makesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MakeCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const b = parsed.data;
    const db = tenantDb(req);
    const userId = sessionUser(req)?.id ?? null;

    if (b.rerun_of) {
      const original = await loadMake(db, b.rerun_of);
      if (!original) {
        res.status(404).json({ error: { code: "not_found", message: "The Make to run again was not found." } });
        return;
      }
      const from = b.from_step!;
      const originalStart = isMakeStep(original.start_step) ? original.start_step : "request";
      if (MAKE_STEPS.indexOf(from) <= MAKE_STEPS.indexOf(originalStart)) {
        res.status(400).json({ error: { code: "before_start", message: `That Make starts at ${originalStart}; run it again from a later step, or start a new one.` } });
        return;
      }
      // Run again what happened: a step the first Make never reached has
      // nothing of its own to run again, and the steps it needs were never
      // made.
      const originalSteps = await stepsOf(db, original.id);
      if (!originalSteps.some((x) => x.step === from)) {
        res.status(400).json({ error: { code: "not_reached", message: `That Make never reached ${from}. Make it again from a step it reached.` } });
        return;
      }
      const made = await db
        .insertInto("digifab_makes")
        .values({
          name: b.name,
          prompt: original.prompt,
          start_step: originalStart,
          rerun_of: original.id,
          rerun_from_step: from,
          created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      // The steps before `from` are copied, not done again, each pointing at
      // the one it came from; their files are the same files, attached again.
      const orgId = tenantContext(req).org.id;
      for (const s of originalSteps) {
        if (MAKE_STEPS.indexOf(s.step) >= MAKE_STEPS.indexOf(from)) continue;
        const files = (await filesOf(orgId, [s.id]))[s.id] ?? [];
        await recordStep(ctxOf(req), made, s.step, {
          status: s.status,
          data: s.data,
          produced_by: s.produced_by,
          service_job_id: s.service_job_id,
          job_id: s.job_id,
          error: s.error,
          copied_from: s.id,
          files: files.map((f) => ({ file_id: f.file_id, role: (FILE_ROLES as readonly string[]).includes(f.role ?? "") ? (f.role as (typeof FILE_ROLES)[number]) : "other" })),
        });
      }
      await platform().activity.log({ orgId, userId, action: "make_created", ref: { module: "digifab", entityType: "make", entityId: made.id }, diff: { name: made.name, rerun_of: original.id } });
      await platform().events.emit("digifab.make.created", { orgId, makeId: made.id, rerunOf: original.id, fromStep: from });
      res.status(201).json(made);
      return;
    }

    res.status(201).json(await startMake(ctxOf(req), b));
  }),
);

// ── Print this: a model to a print, with one yes ───────────────────────────

const PrintThisBody = z
  .object({
    file_id: z.string().uuid().optional(),
    make_id: z.string().uuid().optional(),
    prompt: z.string().trim().min(1).max(8000).optional(),
    source: z.string().trim().min(1).max(200000).optional(),
    source_lang: z.enum(["build123d", "openscad"]).optional(),
    template: z.string().trim().min(1).max(200).optional(),
    params: z.record(z.unknown()).optional(),
    quantity: z.number().int().positive().max(10000).optional(),
    material: z.string().trim().min(1).max(60),
    color: z.string().trim().max(60).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    bbox_mm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  })
  .refine((b) => [!!b.file_id, !!b.make_id, !b.make_id && (!!b.prompt || !!b.source || !!b.template)].filter(Boolean).length === 1, { message: "choose a file, a Make, or a new design", path: ["file_id"] });

// AI-REACH: exempt — the page's own button; Cobb and MCP reach the same flow as the digifab:print-this action
makesRouter.post(
  "/print-this",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PrintThisBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const r = await requireFamilyPrinting().startPrintThis(tenantContext(req).org.id, sessionUser(req)?.id ?? null, { ...parsed.data, origin: "page" });
    if (!r.ok) {
      res.status(r.code === "not_found" || r.code === "no_file" ? 404 : 409).json({ error: { code: r.code, message: r.error }, make_id: r.make_id ?? null });
      return;
    }
    res.status(201).json(r);
  }),
);

// AI-REACH: exempt — the one yes that starts a machine is a person's press on the Make's card; Cobb reaches a send only through digifab:send, which always asks a person
makesRouter.post(
  "/:id/print/start",
  asyncHandler(async (req, res) => {
    // The admin tier, or an operator: a person's press that starts a machine (#6672).
    if (!(await requireCapability(req, res, "digifab:operate"))) return;
    const body = z.object({ confirm_hash: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(req.body);
    if (!body.success) return badBody(res, body.error);
    const r = await requireFamilyPrinting().startPrint(tenantContext(req).org.id, sessionUser(req)?.id ?? null, String(req.params.id), body.data.confirm_hash);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : r.code === "send_failed" ? 502 : 409).json({ error: { code: r.code, message: r.error } });
      return;
    }
    res.json(r);
  }),
);

// ── one Make, its steps, its files and what comes next ────────────────────

makesRouter.get("/print-batches", asyncHandler(async (req, res) => {
  const query = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(100) }).safeParse(req.query);
  if (!query.success) return badBody(res, query.error);
  const page = readListPage(query.data, 100);
  const rows = await tenantDb(req).selectFrom("digifab_make_steps as s")
    .innerJoin("digifab_jobs as j", "j.id", "s.job_id").innerJoin("digifab_makes as m", "m.id", "s.make_id")
    .select(["s.id", "s.make_id", "s.step", "s.status", "s.data", "s.job_id", "s.error", "j.linked_machine_id", "m.name"])
    .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
    .where("s.step", "=", "print").where("s.status", "in", ["awaiting_confirm", "running"])
    .where("j.make_ordinal", "is not", null).orderBy("m.created_at", "asc").orderBy("s.id", "asc").limit(page.limit).offset(page.offset).execute();
  const answer = pagedAnswer(rows, page);
  res.json({ ...answer, next_offset: answer.complete ? null : page.offset + answer.items.length });
}));

// AI-ACTION: digifab:start-next-print
// GATE: starts a physical printer: the admin tier, or an operator through digifab:operate (#6672); the action says the same, so the API and Cobb give one answer
makesRouter.post("/:id/print/next", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:start-next-print"))) return;
  const body = z.object({ bed_clear: z.literal(true), confirm_hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).safeParse(req.body);
  if (!body.success) return badBody(res, body.error);
  const r = await requireFamilyPrinting().startBatch(tenantDb(req), tenantContext(req).org.id, sessionUser(req)?.id ?? null, String(req.params.id), body.data.confirm_hash, true);
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: { code: r.code, message: r.error } });
}));

// AI-ACTION: digifab:review-print-batch
// GATE: re-approves what a batch will physically print, so it stays owner or admin and is not grantable; the action says runBy admin, so the API and Cobb give the same answer
makesRouter.post("/:id/print/review", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const body = z.object({ quantity: z.number().int().positive().max(10000).optional() }).safeParse(req.body ?? {});
  if (!body.success) return badBody(res, body.error);
  const r = await requireFamilyPrinting().reviewBatch(tenantDb(req), tenantContext(req).org.id, String(req.params.id), body.data.quantity);
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: { code: r.code, message: r.error } });
}));

// AI-ACTION: digifab:cancel-print-batch
makesRouter.post("/:id/print/cancel", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "digifab:cancel-print-batch"))) return;
  const r = await requireFamilyPrinting().cancelBatch(tenantDb(req), String(req.params.id));
  res.status(r.ok ? 200 : 409).json(r.ok ? r : { error: { code: r.code, message: r.error } });
}));

makesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const id = String(req.params.id);
    if (!z.string().uuid().safeParse(id).success) {
      res.status(404).json({ error: { code: "not_found", message: "Make not found." } });
      return;
    }
    const make = await loadMake(db, id);
    if (!make) {
      res.status(404).json({ error: { code: "not_found", message: "Make not found." } });
      return;
    }
    const steps = await stepsOf(db, make.id);
    const reach = await reachFor(db, orgId, sessionUser(req)?.id ?? null);
    const files = await filesOf(orgId, steps.map((s) => s.id));

    // The Print step reads its job live: state, progress, and the spools it
    // drew from (never re-derived here).
    const printRow = steps.find((s) => s.step === "print" && s.job_id);
    let print: Record<string, unknown> | null = null;
    if (printRow?.job_id) {
      const job = (await db.selectFrom("digifab_jobs").selectAll().where("id", "=", printRow.job_id).executeTakeFirst()) as Record<string, unknown> | undefined;
      if (job) {
        const drawn = spoolsFromJob(job);
        const spools = await Promise.all(
          drawn.map(async (d) => ({ ...d, title: await platform().entities.titleForEntity(orgId, "inventory:part", d.part_id) })),
        );
        const machineId = typeof job.linked_machine_id === "string" ? job.linked_machine_id : null;
        print = {
          job_id: job.id,
          status: job.status,
          progress: job.progress,
          file_ref: job.file_ref,
          error: job.error,
          machine: machineId
            ? {
                id: machineId,
                title: await platform().entities.titleForEntity(orgId, "machines:machine", machineId),
                detail_url: (await platform().entities.detailPathForEntity(orgId, "machines:machine", machineId)) ?? null,
              }
            : null,
          spools,
          // Measured once the print completes (#4016); the slicer's estimate
          // before that, and on a job that named its own spool.
          material_pending: job.material_pending === true,
          grams_measured: !job.material_pending && Array.isArray(job.material_drawn) && drawn.every(d => readFilamentDrawn(job.material_drawn).some(a => a.part_id === d.part_id && a.slot === d.slot)),
          grams_by_tool: readGramsByTool(job.material_grams_by_tool),
        };
      }
    }

    // What it was made for (an order line, a work order), by name and link.
    const madeFor =
      make.source_kind && make.source_id
        ? {
            kind: make.source_kind,
            id: make.source_id,
            title: await platform().entities.titleForEntity(orgId, make.source_kind, make.source_id).catch(() => null),
            detail_url: (await platform().entities.detailPathForEntity(orgId, make.source_kind, make.source_id).catch(() => undefined)) ?? null,
          }
        : null;
    const parent = make.rerun_of ? await db.selectFrom("digifab_makes").select(["id", "name"]).where("id", "=", make.rerun_of).executeTakeFirst() : null;
    const reruns = await db.selectFrom("digifab_makes").select(["id", "name", "rerun_from_step", "outcome", "created_at"]).where("rerun_of", "=", make.id).orderBy("created_at", "desc").execute();

    // One set of rows for both: the timeline's recorded steps are the same
    // objects as `steps`, files and all, so the page never meets a step
    // without them.
    const rows = steps.map((s) => ({ ...s, files: files[s.id] ?? [] }));
    const [labelled] = await platform().entities.withFieldLabels(orgId, "digifab:make", [make]);
    res.json({
      make: labelled ?? make,
      steps: rows,
      timeline: timelineFor(make, rows, reach),
      reach,
      print,
      rerun_of: parent ?? null,
      made_for: madeFor,
      reruns,
    });
  }),
);

// ── a person's edits: the name, the outcome ────────────────────────────────

const MakePatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    outcome: z.enum(["pass", "fail"]).nullable().optional(),
    outcome_notes: z.string().max(4000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to change");

// AI-REACH: crud — the digifab:make kind's update
makesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = MakePatch.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const make = await loadMake(db, String(req.params.id));
    if (!make) {
      res.status(404).json({ error: { code: "not_found", message: "Make not found." } });
      return;
    }
    const b = parsed.data;
    if (b.name) await db.updateTable("digifab_makes").set({ name: b.name, updated_at: new Date() }).where("id", "=", make.id).execute();
    // A custom field saved on its own merges into what the Make holds.
    if (b.metadata) await db.updateTable("digifab_makes").set({ metadata: platform().db.mergeJsonb("metadata", b.metadata) as never, updated_at: new Date() }).where("id", "=", make.id).execute();
    if (b.outcome !== undefined || b.outcome_notes !== undefined) {
      if (b.outcome === null) {
        await db.deleteFrom("digifab_make_steps").where("make_id", "=", make.id).where("step", "=", "outcome").execute();
        await db.updateTable("digifab_makes").set({ outcome: null }).where("id", "=", make.id).execute();
      } else {
        const prior = await db.selectFrom("digifab_make_steps").select("data").where("make_id", "=", make.id).where("step", "=", "outcome").executeTakeFirst();
        const data = { ...((prior?.data as Record<string, unknown>) ?? {}), ...(b.outcome ? { outcome: b.outcome } : {}), ...(b.outcome_notes !== undefined ? { notes: b.outcome_notes } : {}), source: "person" };
        await recordStep(ctxOf(req), make, "outcome", { data, produced_by: { kind: "person" } });
      }
    }
    res.json(await loadMake(db, make.id));
  }),
);

// AI-REACH: crud — the digifab:make kind's delete
makesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const make = await loadMake(db, String(req.params.id));
    if (!make) {
      res.status(404).json({ error: { code: "not_found", message: "Make not found." } });
      return;
    }
    // The Make's own links go with it. Its files stay, in its folder: a file
    // is never lost because the record that named it went.
    const own: Array<readonly [string, string]> = [
      ["digifab:job", REL_PRINTED_AS],
      ["machines:machine", REL_PRINTED_ON],
      ["inventory:part", REL_USED],
      ...(make.source_kind ? [[make.source_kind, REL_MADE_FOR] as const] : []),
    ];
    for (const [targetKind, rel] of own) {
      const links = await platform().pairings.findBySources({ orgId, sourceKind: MAKE_KIND, sourceIds: [make.id], targetKind, relationshipKind: rel });
      for (const l of links) await platform().pairings.remove({ orgId, sourceKind: MAKE_KIND, sourceId: make.id, targetKind, targetId: l.targetId, relationshipKind: rel });
    }
    await db.deleteFrom("digifab_makes").where("id", "=", make.id).execute();
    await platform().activity.log({ orgId, userId: sessionUser(req)?.id ?? null, action: "make_deleted", ref: { module: "digifab", entityType: "make", entityId: make.id }, diff: { name: make.name } });
    res.status(204).end();
  }),
);

// ── the flows record their steps ───────────────────────────────────────────

const StepRecord = z.object({
  status: z.enum(["running", "needs_input", "awaiting_confirm", "done", "failed"]).default("done"),
  data: z.record(z.unknown()).default({}),
  produced_by: z.record(z.unknown()).optional(),
  service_job_id: z.string().max(200).nullable().optional(),
  job_id: z.string().uuid().nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
  files: z.array(FileRef).max(50).optional(),
});

// UI-REACH: written by whatever did the step, from outside the api (a slicer or printer bridge posting back); a person's own part of a step reaches the Make page through its file door and its outcome
// AI-REACH: exempt — recorded by the flow that did the step (a service job, a send to a printer), not a person's edit; a person starts a Make or sets its outcome through the Make's own create and update
makesRouter.post(
  "/:id/steps/:step",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const step = Step.safeParse(req.params.step);
    if (!step.success) {
      res.status(400).json({ error: { code: "unknown_step", message: `A Make's steps are ${MAKE_STEPS.join(", ")}.` } });
      return;
    }
    const parsed = StepRecord.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    if (step.data === "print") {
      const current = await db.selectFrom("digifab_make_steps").select("data").where("make_id", "=", String(req.params.id)).where("step", "=", "print").executeTakeFirst();
      if (current?.data.batch || parsed.data.data?.batch) return void res.status(409).json({ error: { code: "batch_control_required", message: "Use the batch's review, start and cancel controls to change its approval or history." } });
    }
    const make = await loadMake(db, String(req.params.id));
    if (!make) {
      res.status(404).json({ error: { code: "not_found", message: "Make not found." } });
      return;
    }
    const start = isMakeStep(make.start_step) ? make.start_step : "request";
    if (MAKE_STEPS.indexOf(step.data) < MAKE_STEPS.indexOf(start)) {
      res.status(400).json({ error: { code: "before_start", message: `This Make starts at ${start}.` } });
      return;
    }
    try {
      const id = await recordStep(ctxOf(req), make, step.data, parsed.data);
      res.status(201).json({ id });
    } catch (error) {
      if (error instanceof BatchPrintStepOwnedError) return void res.status(409).json({ error: { code: "batch_control_required", message: error.message } });
      throw error;
    }
  }),
);

// AI-REACH: exempt — a person's own file for a step (the model to print, the G-code they sliced); an upload, which the assistant cannot make
makesRouter.post(
  "/:id/files",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = z.object({ step: z.enum(["model", "slice"]), files: z.array(FileRef).min(1).max(20) }).safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const make = await loadMake(db, String(req.params.id));
    if (!make) {
      res.status(404).json({ error: { code: "not_found", message: "Make not found." } });
      return;
    }
    const existing = await db.selectFrom("digifab_make_steps").select(["id", "produced_by"]).where("make_id", "=", make.id).where("step", "=", parsed.data.step).executeTakeFirst();
    if (existing && (existing.produced_by as Record<string, unknown>).kind !== "upload") {
      res.status(409).json({ error: { code: "step_taken", message: `This Make's ${parsed.data.step} came from a service. Run it again from ${parsed.data.step} to use your own file.` } });
      return;
    }
    const id = await recordStep(ctxOf(req), make, parsed.data.step, { data: { source: "uploaded" }, produced_by: { kind: "upload" }, files: parsed.data.files });
    res.status(201).json({ id });
  }),
);
