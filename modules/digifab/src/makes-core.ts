// Makes (services.md §13): one fabrication run from the request to the
// outcome, every step kept with what produced it and the files it made.
//
// The steps run in one order: Request → Design → Model → Slice → Print →
// Outcome. A Make can start midway (your own STL starts at Model, your own
// G-code at Slice) and can be run again from any step, as a new Make that
// copies the steps before it and points back with `rerun_of`, so the first
// one's history never changes.
//
// What the page shows next is decided here, in `timelineFor`, and nowhere
// else: when every service the chain needs is connected, the steps not yet
// reached show as placeholders; when one is missing, the timeline ends at the
// last step Cobblr can do, with one door to what comes next. Never an empty
// box for something that cannot happen.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { readFilamentDrawn, readGramsByTool } from "@cobblr/platform-contract/filament-draw";
import type { DigifabDB } from "./db.js";

export const MAKE_STEPS = ["request", "design", "model", "slice", "print", "outcome"] as const;
export type MakeStep = (typeof MAKE_STEPS)[number];
export type StepStatus = "running" | "needs_input" | "awaiting_confirm" | "done" | "failed";

export const isMakeStep = (s: unknown): s is MakeStep => typeof s === "string" && (MAKE_STEPS as readonly string[]).includes(s);
const indexOf = (s: MakeStep) => MAKE_STEPS.indexOf(s);

/** The capabilities each step needs from outside Cobblr. Request and Outcome
 *  are a person's; Model comes out of the design job, so it needs what
 *  Design needs. */
export const DESIGN_CAPABILITY = "design.part";
export const SLICE_CAPABILITY = "slice.model";

/** What this workspace can do, for the timeline. */
export interface MakeReach {
  design: boolean;
  slice: boolean;
  /** A printer Cobblr can send to (any digifab connection). */
  print: boolean;
}

/** Where a person goes to connect what is missing. One place, so the door
 *  every Make shows and the Connections page agree. */
export const CONNECT_SERVICE_PATH = (capability: string) => `/me/connections?add=service&capability=${encodeURIComponent(capability)}`;
export const CONNECT_PRINTER_PATH = "/configuration/digifab";

export interface StepRow {
  id: string;
  step: MakeStep;
  status: StepStatus;
  data: Record<string, unknown>;
  produced_by: Record<string, unknown>;
  service_job_id: string | null;
  job_id: string | null;
  error: string | null;
  copied_from: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export type TimelineEntry =
  | { step: MakeStep; state: "recorded"; row: StepRow }
  | { step: MakeStep; state: "waiting"; hint: string };

export interface TimelineDoor {
  label: string;
  /** A page to go to, or an action the Make page carries out itself. */
  href?: string;
  action?: "upload-model" | "upload-gcode" | "rerun" | "outcome";
}

export interface TimelineEnd {
  /** The step the chain cannot reach, or the failed step it stopped at. */
  step: MakeStep;
  reason: "not-connected" | "failed";
  sentence: string;
  doors: TimelineDoor[];
}

export interface Timeline {
  entries: TimelineEntry[];
  /** Set when the chain stops before Outcome. Null when it can run to the
   *  end, or already has. */
  end: TimelineEnd | null;
}

const WAITING: Record<MakeStep, string> = {
  request: "Request: what to make",
  design: "Design: after the request is read",
  model: "Model: made from the design",
  slice: "Slice: after you approve the model",
  print: "Print: after you confirm the slice",
  outcome: "Outcome: say how the print came out",
};

/** The timeline a Make shows: what happened, and what comes next.
 *
 *  Steps before the Make's start are absent, not faked. Recorded steps show
 *  as they are. From the first step not reached, each one the workspace can
 *  do shows as a placeholder; the first one it cannot do ends the timeline,
 *  with the doors that let a person go on. A failed step ends it too, with a
 *  way to run it again. */
export function timelineFor(make: { start_step: string }, rows: StepRow[], reach: MakeReach): Timeline {
  const start = isMakeStep(make.start_step) ? make.start_step : "request";
  const byStep = new Map(rows.map((r) => [r.step, r] as const));
  const entries: TimelineEntry[] = [];
  for (const step of MAKE_STEPS.slice(indexOf(start))) {
    const row = byStep.get(step);
    if (row) {
      entries.push({ step, state: "recorded", row });
      if (row.status === "failed") {
        return {
          entries,
          end: {
            step,
            reason: "failed",
            sentence: row.error ? `${label(step)} failed: ${row.error}` : `${label(step)} failed.`,
            doors: [{ label: `Run ${label(step).toLowerCase()} again`, action: "rerun" }],
          },
        };
      }
      continue;
    }
    const missing = missingFor(step, reach);
    if (missing) {
      return { entries, end: missing };
    }
    entries.push({ step, state: "waiting", hint: WAITING[step] });
  }
  return { entries, end: null };
}

function label(step: MakeStep): string {
  return step.charAt(0).toUpperCase() + step.slice(1);
}

/** Why a step cannot happen here, and the doors past it; null when it can. */
function missingFor(step: MakeStep, reach: MakeReach): TimelineEnd | null {
  if ((step === "design" || step === "model") && !reach.design) {
    return {
      step,
      reason: "not-connected",
      sentence: "No design service is connected. Connect one to have this designed, or bring your own model.",
      doors: [
        { label: "Connect a design service", href: CONNECT_SERVICE_PATH(DESIGN_CAPABILITY) },
        { label: "Upload a model", action: "upload-model" },
      ],
    };
  }
  if (step === "slice" && !reach.slice) {
    return {
      step,
      reason: "not-connected",
      sentence: "No slicer is connected. Download the model to slice it yourself, or connect a slicer to go on.",
      doors: [
        { label: "Connect a slicer", href: CONNECT_SERVICE_PATH(SLICE_CAPABILITY) },
        { label: "Upload G-code", action: "upload-gcode" },
      ],
    };
  }
  if (step === "print" && !reach.print) {
    return {
      step,
      reason: "not-connected",
      sentence: "No printer is connected. Download the file to print it yourself, or connect a printer to go on.",
      doors: [{ label: "Connect a printer", href: CONNECT_PRINTER_PATH }],
    };
  }
  return null;
}

// ── What this workspace can reach ─────────────────────────────────────────

/** Which of the chain's capabilities are connected, the one place that asks:
 *  what platform().services says this person can call here. A failure to ask
 *  is a failure, never read as "nothing connected". */
export async function reachFor(db: Kysely<DigifabDB>, orgId: string, userId: string | null): Promise<MakeReach> {
  const caps = new Set((await platform().services.capabilities(orgId, userId)).map((c) => c.id));
  const { availableDriverKeys } = await import("./drivers/registry.js");
  const driveable = new Set(await availableDriverKeys(db));
  const printer = (await platform().devices.connections().list(orgId)).some(connection => connection.enabled && driveable.has(connection.type));
  return { design: caps.has(DESIGN_CAPABILITY), slice: caps.has(SLICE_CAPABILITY), print: printer };
}

// ── Reading #4016's material columns ──────────────────────────────────────
// Through the contract's readers (filament-draw.ts), so digifab, Makes and the
// slicer step read one shape.

export interface DrawnSpool {
  part_id: string;
  grams: number;
  slot: string | null;
}

export function drawnFromJob(job: Record<string, unknown>): DrawnSpool[] {
  if (Array.isArray(job.material_drawn)) return readFilamentDrawn(job.material_drawn);
  // A job that named its own spool: that spool, and the slicer's estimate.
  if (typeof job.material_part_id === "string" && job.material_part_id) {
    const grams = Number(job.material_grams);
    return [{ part_id: job.material_part_id, grams: Number.isFinite(grams) ? grams : 0, slot: null }];
  }
  return [];
}


// ── Links: the machine, each spool, the job ───────────────────────────────
// So a printer's page and a spool's page list the Makes that used them.

export const MAKE_KIND = "digifab:make";
export const REL_PRINTED_ON = "printed-on";
export const REL_USED = "used";
export const REL_PRINTED_AS = "printed-as";
/** A Make made for something: an order line, a work order. */
export const REL_MADE_FOR = "made-for";

/** A Make's outcome is known: "pass" or "fail", with what it was made for,
 *  so the order or work order that asked for it can count it made. */
export async function emitMakeCompleted(
  orgId: string,
  make: { id: string; source_kind?: string | null; source_id?: string | null },
  outcome: "pass" | "fail",
): Promise<void> {
  await platform().events.emit("digifab.make.completed", {
    orgId,
    makeId: make.id,
    outcome,
    ...(make.source_kind && make.source_id ? { source: { kind: make.source_kind, id: make.source_id } } : {}),
  });
}

async function linkOnce(orgId: string, makeId: string, targetKind: string, targetId: string, rel: string, userId: string | null): Promise<void> {
  const have = await platform().pairings.findBySources({ orgId, sourceKind: MAKE_KIND, sourceIds: [makeId], targetKind, relationshipKind: rel });
  if (have.some((p) => p.targetId === targetId)) return;
  await platform().pairings.create({ orgId, sourceKind: MAKE_KIND, sourceId: makeId, targetKind, targetId, relationshipKind: rel, createdBy: userId });
}

/** Link a Make to what its Print step used: the job, the machine it ran on,
 *  and each spool. Idempotent, so it runs at send and again when the print
 *  completes and the spools it actually drew from are known. */
export async function linkPrint(db: Kysely<DigifabDB>, orgId: string, makeId: string, jobId: string, userId: string | null): Promise<void> {
  const job = (await db.selectFrom("digifab_jobs").selectAll().where("id", "=", jobId).executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!job) return;
  await linkOnce(orgId, makeId, "digifab:job", jobId, REL_PRINTED_AS, userId);
  const machineId = typeof job.linked_machine_id === "string" ? job.linked_machine_id : null;
  let printerName: string | null = null;
  if (machineId) {
    await linkOnce(orgId, makeId, "machines:machine", machineId, REL_PRINTED_ON, userId);
    printerName = await platform().entities.titleForEntity(orgId, "machines:machine", machineId);
  }
  const spools = drawnFromJob(job);
  const materials: string[] = [];
  for (const s of spools) {
    await linkOnce(orgId, makeId, "inventory:part", s.part_id, REL_USED, userId);
    const title = await platform().entities.titleForEntity(orgId, "inventory:part", s.part_id);
    if (title) materials.push(title);
  }
  const material = materials.join(", ") || (typeof job.material_type === "string" ? job.material_type : null);
  await db
    .updateTable("digifab_makes")
    .set({
      ...(printerName ? { printer_name: printerName } : {}),
      ...(material ? { material } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", makeId)
    .execute();
}

/** When a digifab job settles, the Make it printed catches up: its Print
 *  step's status, and links to the spools the print actually drew from.
 *  Nothing when the job belongs to no Make. */
export async function settleMakeForJob(db: Kysely<DigifabDB>, orgId: string, jobId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
  const { settleBatchForJob } = await import("./print-batch.js");
  if (await settleBatchForJob(db, orgId, jobId, status)) return;
  const step = await db.selectFrom("digifab_make_steps").select(["id", "make_id"]).where("job_id", "=", jobId).where("step", "=", "print").executeTakeFirst();
  if (!step) return;
  await db
    .updateTable("digifab_make_steps")
    .set({ status: status === "completed" ? "done" : "failed", error: status === "completed" ? null : status === "cancelled" ? "cancelled at the printer" : "the print failed", updated_at: new Date() })
    .where("id", "=", step.id)
    .execute();
  await linkPrint(db, orgId, step.make_id, jobId, null);
}

/** The bed-clear verdict on a job is the Make's outcome, unless a person
 *  already said otherwise on the Make itself. */
export async function recordVerdictOnMake(db: Kysely<DigifabDB>, orgId: string, jobId: string, verdict: "good" | "scrapped"): Promise<void> {
  const batchJob = await db.selectFrom("digifab_jobs").select(["make_id", "make_ordinal"]).where("id", "=", jobId).executeTakeFirst();
  if (batchJob?.make_ordinal && batchJob.make_id) {
    const print = await db.selectFrom("digifab_make_steps").select("data").where("make_id", "=", batchJob.make_id).where("step", "=", "print").executeTakeFirst();
    if ((print?.data.batch as { state?: string } | undefined)?.state !== "complete") return;
  }
  const step = await db.selectFrom("digifab_make_steps").select(["make_id"]).where("job_id", "=", jobId).where("step", "=", "print").executeTakeFirst();
  if (!step) return;
  const outcome = verdict === "good" ? "pass" : "fail";
  const inserted = await db
    .insertInto("digifab_make_steps")
    .values({
      make_id: step.make_id,
      step: "outcome",
      status: "done",
      data: JSON.stringify({ outcome, source: "bed-check" }),
      produced_by: JSON.stringify({ kind: "person", name: "Bed check" }),
    })
    .onConflict((oc) => oc.columns(["make_id", "step"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) {
    const make = await db
      .updateTable("digifab_makes")
      .set({ outcome, updated_at: new Date() })
      .where("id", "=", step.make_id)
      .returning(["id", "source_kind", "source_id"])
      .executeTakeFirst();
    if (make) await emitMakeCompleted(orgId, make, outcome);
  }
}

// ── Files: one folder per Make, attached to the step and the Make ─────────

export const FILE_ROLES = ["source", "step", "stl", "3mf", "preview", "report", "gcode", "settings", "snapshot", "photo", "other"] as const;
export type MakeFileRole = (typeof FILE_ROLES)[number];

/** The folder a Make's files live in ("Makes / <name>"), made the first time. */
export async function folderFor(db: Kysely<DigifabDB>, orgId: string, make: { id: string; name: string; folder_id: string | null }): Promise<string | null> {
  if (make.folder_id) return make.folder_id;
  // Folder names are unique per level, so two Makes of one name share a
  // folder only if we let them: the short id keeps each its own.
  const folderId = await platform().files.ensureFolder(orgId, ["Makes", `${make.name.slice(0, 100)} (${make.id.slice(0, 8)})`]);
  if (folderId) await db.updateTable("digifab_makes").set({ folder_id: folderId }).where("id", "=", make.id).execute();
  return folderId;
}

/** Attach a stored file to a step and to its Make, and keep it in the Make's
 *  folder (unless it already lives somewhere else: bytes are kept once). */
export async function attachToStep(
  db: Kysely<DigifabDB>,
  orgId: string,
  make: { id: string; name: string; folder_id: string | null },
  stepId: string,
  fileId: string,
  role: MakeFileRole,
): Promise<void> {
  await platform().files.attach(orgId, { fileId, source_module: "digifab", source_type: "make-step", source_id: stepId, role });
  await platform().files.attach(orgId, { fileId, source_module: "digifab", source_type: "make", source_id: make.id, role });
  const folderId = await folderFor(db, orgId, make);
  if (folderId) await platform().files.fileInto(orgId, fileId, folderId);
}

// ── Recording a step: the one write every door goes through ──────────────

export interface StepWrite {
  status?: StepRow["status"];
  data?: Record<string, unknown>;
  produced_by?: Record<string, unknown>;
  service_job_id?: string | null;
  job_id?: string | null;
  error?: string | null;
  files?: Array<{ file_id: string; role: MakeFileRole }>;
  copied_from?: string | null;
}

/** Record (or replace) one step of a Make, attach its files, and keep the
 *  Make's search copies current. Routes and flows alike write through here. */
export class BatchPrintStepOwnedError extends Error {
  constructor() { super("Use the batch controls to change its approval or history."); }
}

export async function recordMakeStep(
  db: Kysely<DigifabDB>,
  orgId: string,
  userId: string | null,
  make: { id: string; name: string; folder_id: string | null },
  step: MakeStep,
  body: StepWrite,
): Promise<string> {
  const values = {
    status: body.status ?? "done",
    data: JSON.stringify(body.data ?? {}),
    produced_by: JSON.stringify(body.produced_by ?? { kind: "person" }),
    service_job_id: body.service_job_id ?? null,
    job_id: body.job_id ?? null,
    error: body.error ?? null,
    copied_from: body.copied_from ?? null,
    updated_at: new Date(),
  };
  // Files BEFORE a finished status (#4890, torn status writes): the step was
  // written "done" and its files attached after, so another viewer could see
  // a done step with nothing in it. With files to attach, the step is written
  // "running" first (it needs an id to attach to), the files go on, and only
  // then does it take its final status.
  const files = body.files ?? [];
  const finalStatus = values.status;
  const holding = files.length > 0 && (finalStatus === "done" || finalStatus === "failed");
  const first = holding ? { ...values, status: "running" as const } : values;
  const row = await db
    .insertInto("digifab_make_steps")
    .values({ make_id: make.id, step, ...first })
    .onConflict((oc) => {
      const update = oc.columns(["make_id", "step"]).doUpdateSet(first);
      // The route's earlier read can precede batch preparation. Guard the
      // actual write so a delayed ordinary edit cannot erase its journal.
      return step === "print" && !body.data?.batch
        ? update.where(sql<boolean>`digifab_make_steps.data -> 'batch' is null`)
        : update;
    })
    .returning("id")
    .executeTakeFirst();
  if (!row) throw new BatchPrintStepOwnedError();
  for (const f of files) await attachToStep(db, orgId, make, row.id, f.file_id, f.role);
  if (holding) await db.updateTable("digifab_make_steps").set({ status: finalStatus, updated_at: new Date() }).where("id", "=", row.id).execute();

  // The slicer's grams per tool are what the print deducts, whoever sliced:
  // written onto the job the Print step points at, once there is one.
  if (step === "print" && body.job_id) {
    const slice = await db.selectFrom("digifab_make_steps").select("data").where("make_id", "=", make.id).where("step", "=", "slice").executeTakeFirst();
    const grams = readGramsByTool((slice?.data as Record<string, unknown> | undefined)?.grams_by_tool);
    if (grams && (await jobHasColumn(db, "material_grams_by_tool"))) {
      await sql`update digifab_jobs set material_grams_by_tool = ${JSON.stringify(grams)}::jsonb where id = ${body.job_id} and material_grams_by_tool is null`.execute(db);
    }
    await linkPrint(db, orgId, make.id, body.job_id, userId);
  }
  if (step === "outcome") {
    const outcome = body.data?.outcome;
    if (outcome === "pass" || outcome === "fail") {
      await db.updateTable("digifab_makes").set({ outcome }).where("id", "=", make.id).execute();
      await emitMakeCompleted(orgId, make, outcome);
    }
  }
  if (step === "slice") {
    const material = typeof body.data?.material === "string" ? body.data.material : null;
    if (material) await db.updateTable("digifab_makes").set({ material }).where("id", "=", make.id).where("material", "is", null).execute();
  }
  await db.updateTable("digifab_makes").set({ updated_at: new Date() }).where("id", "=", make.id).execute();
  return row.id;
}

// A column #4016 adds; asked of the database once per process rather than
// assumed, so this build works before and after that migration.
const columnCache = new Map<string, boolean>();
async function jobHasColumn(db: Kysely<DigifabDB>, column: string): Promise<boolean> {
  const hit = columnCache.get(column);
  if (hit === true) return true;
  const r = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_name = 'digifab_jobs' and column_name = ${column}`.execute(db);
  const has = (r.rows[0]?.n ?? 0) > 0;
  if (has) columnCache.set(column, true);
  return has;
}
