// Print this (Services §14.3): a model to a print, with one yes.
//
//   1. A Make, at the Model step with the file (or the Make you already have).
//   2. The printer: pick-printer's rule (it fits, then it is loaded with the
//      filament, then it is idle, then the pool order), with the model's size
//      when it can be known and "not known" when it cannot.
//   3. The slice, by the connected slicer (`slice.model`), for that printer's
//      Printing profile and the filament asked for. A service job, gated like
//      every other one.
//   4. When the slice is done: a digifab job for that printer, NOT sent, and
//      the Print step waiting for a person (`awaiting_confirm`), with the
//      preview, the printer, the spool and its slot, the grams and the time.
//   5. The one yes: startPrint, from the Make page's card. Only then does a
//      machine move.
//
// Every step lands on the Make as it happens, so a person can stop at any
// card and the Make keeps what exists, and a restart picks up from the Make's
// own state: the slice's completion arrives as an event whenever the services
// poller settles the job, and the handler is a no-op for a step already moved.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { gatherCandidates } from "./api/printing-profiles.js";
import { rankPrinters, type PickedPrinter } from "./pick-printer.js";
import { reportedSize, stlSize, type Size } from "./model-size.js";
import { MAKE_KIND, SLICE_CAPABILITY, folderFor, recordMakeStep, type MakeFileRole } from "./makes-core.js";
import { sendAndWatch } from "./api/jobs.js";

export interface PrintThisAsk {
  /** A model (STL or 3MF) or G-code in the workspace's files. */
  file_id?: string;
  /** A Make that already has its model. */
  make_id?: string;
  material: string;
  color?: string | null;
  name?: string;
  /** The part's size when the caller knows it better than the file does. */
  bbox_mm?: Size | null;
  origin?: "page" | "cobb" | "mcp";
}

export type PrintThisResult =
  | { ok: true; make_id: string; created_make: boolean; printer: { machine: string | null; reason: string }; slice_job_id: string | null; summary: string }
  | { ok: false; code: string; error: string; make_id?: string; created_make?: boolean };

type MakeRow = { id: string; name: string; folder_id: string | null; start_step: string; created_by: string | null };

const MODEL_ROLES: readonly MakeFileRole[] = ["stl", "3mf"];

function roleOf(filename: string, mime: string): "stl" | "3mf" | "gcode" | null {
  const f = filename.toLowerCase();
  if (f.endsWith(".stl") || mime === "model/stl") return "stl";
  if (f.endsWith(".3mf") || mime === "model/3mf") return "3mf";
  if (f.endsWith(".gcode") || f.endsWith(".bgcode") || mime === "text/x.gcode") return "gcode";
  return null;
}

const tenantDb = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;

async function loadMake(db: Kysely<DigifabDB>, id: string): Promise<MakeRow | undefined> {
  return db.selectFrom("digifab_makes").select(["id", "name", "folder_id", "start_step", "created_by"]).where("id", "=", id).executeTakeFirst();
}

/** The model file a Make's Model step (or its Slice step, for G-code) holds. */
async function modelOf(orgId: string, db: Kysely<DigifabDB>, makeId: string): Promise<{ fileId: string; role: "stl" | "3mf" | "gcode"; report: unknown } | null> {
  const steps = await db.selectFrom("digifab_make_steps").select(["id", "step", "data"]).where("make_id", "=", makeId).where("step", "in", ["model", "slice"]).execute();
  for (const want of ["model", "slice"] as const) {
    const step = steps.find((s) => s.step === want);
    if (!step) continue;
    const files = (await platform().files.listAttachments(orgId, { source_module: "digifab", source_type: "make-step", source_id: step.id })) ?? [];
    for (const f of files) {
      const role = want === "model" ? (MODEL_ROLES.includes(f.role as MakeFileRole) ? (f.role as "stl" | "3mf") : roleOf(f.filename, f.mimeType)) : roleOf(f.filename, f.mimeType);
      if (role && (want === "slice" ? role === "gcode" : role !== "gcode")) return { fileId: f.fileId, role, report: (step.data as Record<string, unknown>)?.report };
    }
  }
  return null;
}

/** Start Print this: a Make, a printer, a slice. Sends nothing. */
export async function startPrintThis(orgId: string, userId: string | null, ask: PrintThisAsk): Promise<PrintThisResult> {
  const material = ask.material?.trim();
  if (!material) return { ok: false, code: "no_material", error: "Say which material to print in (PLA, PETG, ...)." };
  const db = await tenantDb(orgId);

  // 1. The Make and its model.
  let make: MakeRow | undefined;
  let created = false;
  let model: { fileId: string; role: "stl" | "3mf" | "gcode"; report: unknown } | null = null;
  if (ask.make_id) {
    make = await loadMake(db, ask.make_id);
    if (!make) return { ok: false, code: "not_found", error: "That Make was not found." };
    model = await modelOf(orgId, db, make.id);
    if (!model) return { ok: false, code: "no_model", error: "This Make has no model to print yet. Upload one, or let its design finish.", make_id: make.id };
  } else if (ask.file_id) {
    const file = await platform().files.read(orgId, ask.file_id, "original");
    if (!file) return { ok: false, code: "no_file", error: "That file was not found." };
    const role = roleOf(file.filename, file.mimeType);
    if (!role) return { ok: false, code: "not_printable", error: `${file.filename} is not a model or G-code. Print this takes an STL, a 3MF or G-code.` };
    const startStep = role === "gcode" ? "slice" : "model";
    const name = (ask.name?.trim() || file.filename.replace(/\.[^.]+$/, "")).slice(0, 200);
    make = await db
      .insertInto("digifab_makes")
      .values({ name, prompt: null, start_step: startStep, created_by: userId })
      .returning(["id", "name", "folder_id", "start_step", "created_by"])
      .executeTakeFirstOrThrow();
    created = true;
    await recordMakeStep(db, orgId, userId, make, startStep, {
      data: { source: "uploaded", origin: ask.origin ?? "page" },
      produced_by: { kind: "upload" },
      files: [{ file_id: ask.file_id, role }],
    });
    await platform().activity.log({ orgId, userId, action: "make_created", ref: { module: "digifab", entityType: "make", entityId: make.id }, diff: { name: make.name } });
    await platform().events.emit("digifab.make.created", { orgId, makeId: make.id });
    model = { fileId: ask.file_id, role, report: null };
  } else {
    return { ok: false, code: "nothing_to_print", error: "Say which file or which Make to print." };
  }
  const fail = (code: string, error: string): PrintThisResult => ({ ok: false, code, error, make_id: make!.id, created_make: created });

  // 2. The printer. The size is the caller's, else the design's report, else
  //    read off an STL's own bytes; a 3MF with none of those is "not known".
  let size: Size | null = ask.bbox_mm ?? reportedSize(model.report);
  if (!size && model.role === "stl") {
    const bytes = await platform().files.read(orgId, model.fileId, "original");
    size = bytes ? stlSize(bytes.bytes) : null;
  }
  const ranked = rankPrinters({ material, color: ask.color ?? null, grams: null, bbox_mm: size }, await gatherCandidates(orgId, db));
  const best = ranked.find((p) => p.usable && p.fits !== false) ?? null;
  if (!best) {
    return fail(
      "no_printer",
      ranked.length
        ? `No linked printer can take this print: ${ranked.map((p) => `${p.machine.label ?? p.device.name ?? "a printer"} (${p.reason})`).join("; ")}.`
        : "No printer is linked to a machine manager yet. Link one to a machine first.",
    );
  }
  const printer = {
    machine_id: best.machine.id,
    machine: best.machine.label,
    connection_id: best.device.connection_id,
    remote_device_id: best.device.remote_device_id,
    device: best.device.name,
    reason: best.reason,
    spool: best.loaded ? { id: best.loaded.spool.id, kind: best.loaded.spool.kind, name: best.loaded.spool.name, slot: best.loaded.slot } : null,
    size_mm: size,
  };
  const choice = { material, color: ask.color ?? null, printer, others: ranked.filter((p) => p !== best).slice(0, 4).map(brief) };

  // A G-code is already sliced: straight to the one yes.
  if (model.role === "gcode") {
    const sliceStep = await db.selectFrom("digifab_make_steps").select(["id", "data"]).where("make_id", "=", make.id).where("step", "=", "slice").executeTakeFirst();
    await recordMakeStep(db, orgId, userId, make, "slice", { data: { ...((sliceStep?.data as Record<string, unknown>) ?? {}), ...choice }, produced_by: { kind: "upload" } });
    const ready = await readyToPrint(db, orgId, make, { gcodeFileId: model.fileId, choice, grams: null, seconds: null, previewFileId: null });
    if (!ready.ok) return fail(ready.code, ready.error);
    return { ok: true, make_id: make.id, created_make: created, printer: { machine: printer.machine, reason: printer.reason }, slice_job_id: null, summary: `Ready to print on ${printer.machine ?? printer.device ?? "the printer"}. Confirm it on the Make.` };
  }

  // 3. The slice, for that printer's profile.
  const profile = best.profile;
  if (!profile?.printer_model || profile.nozzle_mm == null || !profile.quality) {
    return fail("no_profile", `${printer.machine ?? "The chosen printer"} has no Printing profile yet. Set its printer model, nozzle and quality on its page, then print this again.`);
  }
  const filament: Record<string, unknown> = { material, ...(ask.color ? { color: ask.color } : {}), ...(profile.preset_hint ? { preset: profile.preset_hint } : {}) };
  const sliceStepId = await recordMakeStep(db, orgId, userId, make, "slice", {
    status: "running",
    data: { ...choice, printer_model: profile.printer_model, nozzle_mm: profile.nozzle_mm, quality: profile.quality },
    produced_by: { kind: "service", capability: SLICE_CAPABILITY },
  });
  let job: { id: string; status: string };
  try {
    job = await platform().services.invoke({
      orgId,
      capability: SLICE_CAPABILITY,
      input: { printer_model: profile.printer_model, nozzle_mm: profile.nozzle_mm, quality: profile.quality, filament: [filament] },
      files: { model: model.fileId },
      attachTo: { kind: "digifab:make-step", id: sliceStepId },
      idempotencyKey: `print-this:${make.id}:${sliceStepId}`,
    });
  } catch (err) {
    const message = (err as Error).message || "the slicer could not be reached";
    await recordMakeStep(db, orgId, userId, make, "slice", { status: "failed", data: { ...choice }, produced_by: { kind: "service", capability: SLICE_CAPABILITY }, error: message });
    return fail("slice_refused", `The slice could not start: ${message}`);
  }
  await db.updateTable("digifab_make_steps").set({ service_job_id: job.id, updated_at: new Date() }).where("id", "=", sliceStepId).execute();
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") await onSliceSettled(orgId, job.id);
  return {
    ok: true,
    make_id: make.id,
    created_make: created,
    printer: { machine: printer.machine, reason: printer.reason },
    slice_job_id: job.id,
    summary: `Slicing for ${printer.machine ?? printer.device ?? "the printer"} (${printer.reason}). The Make asks you before anything prints.`,
  };
}

function brief(p: PickedPrinter) {
  return { machine: p.machine.label ?? p.device.name, reason: p.reason };
}

/** A slice job settled: its outputs land on the Slice step, and a done slice
 *  becomes a digifab job waiting for its one yes. Nothing for a job that is
 *  not a Print this slice, or a step already moved on (so a second event, or
 *  one after a restart, changes nothing). */
export async function onSliceSettled(orgId: string, jobId: string): Promise<void> {
  const db = await tenantDb(orgId).catch(() => null);
  if (!db) return;
  const step = await db
    .selectFrom("digifab_make_steps")
    .select(["id", "make_id", "status", "data"])
    .where("service_job_id", "=", jobId)
    .where("step", "=", "slice")
    .executeTakeFirst()
    .catch(() => undefined);
  if (!step || step.status !== "running") return;
  const make = await loadMake(db, step.make_id);
  if (!make) return;
  const sj = await platform().services.job(orgId, jobId);
  if (!sj) return;
  const prior = (step.data as Record<string, unknown>) ?? {};
  const producedBy = { kind: "service", capability: SLICE_CAPABILITY, name: sliceName(sj.output), version: sliceVersion(sj.output) };
  if (sj.status === "failed" || sj.status === "cancelled") {
    await recordMakeStep(db, orgId, null, make, "slice", {
      status: "failed",
      data: prior,
      produced_by: producedBy,
      service_job_id: jobId,
      error: sj.error?.message ?? (sj.status === "cancelled" ? "the slice was stopped" : "the slice failed"),
    });
    return;
  }
  if (sj.status !== "done") return;

  const out = (sj.output ?? {}) as Record<string, unknown>;
  const outFiles = sj.files.filter((f) => f.direction === "out");
  const gcode = outFiles.find((f) => f.name === "gcode") ?? outFiles.find((f) => f.name === "plain_gcode");
  const preview = outFiles.find((f) => f.name === "preview");
  const grams = Array.isArray(out.grams_per_tool) ? (out.grams_per_tool as unknown[]).map(Number) : null;
  const seconds = typeof out.estimated_seconds === "number" ? out.estimated_seconds : null;
  const total = typeof out.total_grams === "number" ? out.total_grams : grams ? grams.reduce((a, b) => a + b, 0) : null;
  if (!gcode) {
    await recordMakeStep(db, orgId, null, make, "slice", { status: "failed", data: prior, produced_by: producedBy, service_job_id: jobId, error: "the slicer finished without a file to print" });
    return;
  }
  // The service already attached its outputs to this step; they join the
  // Make and its folder here.
  const files: Array<{ file_id: string; role: MakeFileRole }> = [];
  for (const f of outFiles) files.push({ file_id: f.file_id, role: f.name === "preview" ? "preview" : f.name === "gcode" && gcodeIs3mf(f) ? "3mf" : "gcode" });
  for (const f of files) await adoptIntoMake(db, orgId, make, f.file_id, f.role);
  await recordMakeStep(db, orgId, null, make, "slice", {
    status: "done",
    data: {
      ...prior,
      grams_by_tool: grams,
      total_grams: total,
      time_s: seconds,
      layers: out.layers ?? null,
      settings: out.settings_snapshot ?? null,
      profile_hash: out.profile_sha ?? null,
      material: prior.material ?? null,
    },
    produced_by: producedBy,
    service_job_id: jobId,
  });
  const choice = prior as { printer?: Record<string, unknown>; material?: string };
  await readyToPrint(db, orgId, make, { gcodeFileId: gcode.file_id, choice, grams: total, seconds, previewFileId: preview?.file_id ?? null });
}

function sliceName(output: unknown): string | null {
  const s = (output as { slicer?: { name?: unknown } } | null)?.slicer;
  return typeof s?.name === "string" ? s.name : null;
}
function sliceVersion(output: unknown): string | null {
  const s = (output as { slicer?: { version?: unknown } } | null)?.slicer;
  return typeof s?.version === "string" ? s.version : null;
}
function gcodeIs3mf(f: { name: string; file_id: string }): boolean {
  return /3mf/i.test(f.name);
}

/** A service's output file joins the Make (and its folder); the step already
 *  holds it through the job's attach_to. */
async function adoptIntoMake(db: Kysely<DigifabDB>, orgId: string, make: MakeRow, fileId: string, role: MakeFileRole): Promise<void> {
  await platform().files.attach(orgId, { fileId, source_module: "digifab", source_type: "make", source_id: make.id, role });
  const folderId = await folderFor(db, orgId, make);
  if (folderId) await platform().files.fileInto(orgId, fileId, folderId);
}

/** The digifab job for the chosen printer, created but NOT sent, and the Print
 *  step waiting for its one yes. The person who asked hears that it is ready. */
async function readyToPrint(
  db: Kysely<DigifabDB>,
  orgId: string,
  make: MakeRow,
  o: { gcodeFileId: string; choice: { printer?: Record<string, unknown>; material?: string | null }; grams: number | null; seconds: number | null; previewFileId: string | null },
): Promise<{ ok: true; jobId: string } | { ok: false; code: string; error: string }> {
  const p = (o.choice.printer ?? {}) as { machine_id?: string; machine?: string | null; connection_id?: string; remote_device_id?: string; device?: string | null; spool?: { id?: string; name?: string | null; slot?: string | null } | null };
  if (!p.connection_id || !p.remote_device_id) return { ok: false, code: "no_printer", error: "The chosen printer is no longer known." };
  const file = await platform().files.read(orgId, o.gcodeFileId, "original");
  const job = await db
    .insertInto("digifab_jobs")
    .values({
      connection_id: p.connection_id,
      file_ref: file?.filename ?? `${make.name}.gcode`,
      target_device: p.remote_device_id,
      file_id: o.gcodeFileId,
      linked_machine_id: p.machine_id ?? null,
      material_part_id: p.spool?.id ?? null,
      material_grams: o.grams != null ? String(o.grams) : null,
      material_type: o.choice.material ?? null,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  await platform().activity.log({ orgId, userId: null, action: "job_created", ref: { module: "digifab", entityType: "job", entityId: job.id }, diff: { name: file?.filename ?? make.name, make: make.id } });
  await recordMakeStep(db, orgId, null, make, "print", {
    status: "awaiting_confirm",
    job_id: job.id,
    data: {
      printer: p.machine ?? p.device ?? null,
      machine_id: p.machine_id ?? null,
      spool: p.spool?.name ?? null,
      slot: p.spool?.slot ?? null,
      grams: o.grams,
      time_s: o.seconds,
      preview_file_id: o.previewFileId,
    },
    produced_by: { kind: "digifab" },
  });
  await announceReady(orgId, make, p.machine ?? p.device ?? null);
  return { ok: true, jobId: job.id };
}

/** "Ready to print" to the person who asked (everyone who can start a print,
 *  when nobody did), linking to the Make where the one yes lives. */
async function announceReady(orgId: string, make: MakeRow, printer: string | null): Promise<void> {
  const to = make.created_by ? [make.created_by] : await platform().notifications.orgMemberIds(orgId).catch(() => [] as string[]);
  const message = `Ready to print: ${make.name}${printer ? ` on ${printer}` : ""}. Start it from the Make.`;
  await Promise.all(
    to.map((userId) =>
      platform()
        // dispatch-per-row-ok: one message to each person told about this one Make, never one per record
        .notifications.dispatch({ orgId, userId, eventType: "digifab.make.ready", message, link_url: `/makes/${make.id}`, module: "digifab", entityType: MAKE_KIND, entityId: make.id })
        .catch((err: unknown) => console.warn(`[digifab] make ${make.id}: ready notice not sent: ${(err as Error).message}`)),
    ),
  );
}

/** The one yes: send the Make's waiting print. A person's press on the Make's
 *  card, and nothing else, reaches here. */
export async function startPrint(orgId: string, userId: string | null, makeId: string): Promise<{ ok: true; status: string } | { ok: false; code: string; error: string }> {
  const db = await tenantDb(orgId);
  const make = await loadMake(db, makeId);
  if (!make) return { ok: false, code: "not_found", error: "Make not found." };
  const step = await db.selectFrom("digifab_make_steps").select(["status", "job_id", "data"]).where("make_id", "=", makeId).where("step", "=", "print").executeTakeFirst();
  if (!step?.job_id) return { ok: false, code: "nothing_waiting", error: "This Make has no print waiting to start." };
  // The yes is claimed before anything is sent: of two presses (two tabs, the
  // card and a notification) exactly one moves the step off awaiting_confirm,
  // and only that one sends.
  const claimed = await db
    .updateTable("digifab_make_steps")
    .set({ status: "running", updated_at: new Date() })
    .where("make_id", "=", makeId)
    .where("step", "=", "print")
    .where("status", "=", "awaiting_confirm")
    .returning("id")
    .executeTakeFirst();
  if (!claimed) return { ok: false, code: "already_started", error: "This print has already been started." };
  const r = await sendAndWatch(db, orgId, step.job_id);
  if (!r.ok) {
    // Nothing reached the printer: the print waits for its yes again, saying why.
    await recordMakeStep(db, orgId, userId, make, "print", { status: "awaiting_confirm", job_id: step.job_id, data: (step.data as Record<string, unknown>) ?? {}, produced_by: { kind: "digifab" }, error: r.message });
    return { ok: false, code: r.code, error: r.message };
  }
  await recordMakeStep(db, orgId, userId, make, "print", { status: "running", job_id: step.job_id, data: { ...((step.data as Record<string, unknown>) ?? {}), started_by: userId }, produced_by: { kind: "digifab" } });
  return { ok: true, status: r.status };
}

/** Wire it: the slice's completion, and the action Cobb and MCP reach it by. */
export function registerPrintThis(): void {
  const settled = async (payload: unknown) => {
    const p = payload as { orgId?: string; jobId?: string; capability?: string };
    if (!p.orgId || !p.jobId || p.capability !== SLICE_CAPABILITY) return;
    try {
      await onSliceSettled(p.orgId, p.jobId);
    } catch (err) {
      console.warn(`[digifab] print this: slice ${p.jobId} not taken up: ${(err as Error).message}`);
    }
  };
  platform().events.on("services.job.done", "digifab.print-this", settled);
  platform().events.on("services.job.failed", "digifab.print-this", settled);

  platform().actions.registerHandler("digifab.print-this", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const size = Array.isArray(a.bbox_mm) && a.bbox_mm.length === 3 && a.bbox_mm.every((v) => Number(v) > 0) ? (a.bbox_mm.map(Number) as Size) : null;
    return startPrintThis(ctx.orgId, ctx.userId ?? null, {
      file_id: typeof a.file_id === "string" ? a.file_id : undefined,
      make_id: typeof a.make_id === "string" ? a.make_id : undefined,
      material: typeof a.material === "string" ? a.material : "",
      color: typeof a.color === "string" ? a.color : null,
      bbox_mm: size,
      origin: "cobb",
    });
  });
  // A Make this run created goes again; one it was handed stays.
  platform().actions.registerUndo("digifab.print-this", (result) => {
    const r = result as { make_id?: unknown; created_make?: unknown } | null;
    if (typeof r?.make_id !== "string" || r.created_make !== true) return null;
    return { tool: "delete", entity_kind: MAKE_KIND, entity_id: r.make_id };
  });
}
