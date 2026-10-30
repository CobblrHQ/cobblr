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

import { createHash } from "node:crypto";
import { readGramsByTool } from "@cobblr/platform-contract/filament-draw";
import { canonicalJson } from "@cobblr/platform-contract/service-consent";
import type { Kysely } from "kysely";
import { platform, type ActionHandler } from "@cobblr/platform-contract";
import type { DigifabDB } from "../../db.js";
import { gatherCandidates } from "./api/printing-profiles.js";
import { rankPrinters, type PickedPrinter } from "./pick-printer.js";
import { reportedSize, stlSize, type Size } from "../../model-size.js";
import { MAKE_KIND, SLICE_CAPABILITY, DESIGN_CAPABILITY, folderFor, recordMakeStep, type MakeFileRole } from "../../makes-core.js";
import { extractPlateMetadata } from "../../library/extract-metadata.js";
import { sendAndWatch } from "../../api/jobs.js";
import { prepareBatch, startBatchPrint, recoverBatches } from "./print-batch.js";
import type { PrintThisAsk, PrintThisResult } from "../../core/printing.js";

export type { PrintThisAsk, PrintThisResult } from "../../core/printing.js";

type MakeRow = { id: string; name: string; folder_id: string | null; start_step: string; created_by: string | null };

const MODEL_ROLES: readonly MakeFileRole[] = ["stl", "step", "3mf"];

function roleOf(filename: string, mime: string): "stl" | "step" | "3mf" | "gcode" | null {
  const f = filename.toLowerCase();
  if (f.endsWith(".stl") || mime === "model/stl") return "stl";
  if (/\.(step|stp)$/.test(f) || mime === "model/step") return "step";
  if (f.endsWith(".3mf") || mime === "model/3mf") return "3mf";
  if (/\.(gcode|bgcode|gco)$/.test(f) || mime === "text/x.gcode") return "gcode";
  return null;
}

const tenantDb = async (orgId: string) => (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;

async function loadMake(db: Kysely<DigifabDB>, id: string): Promise<MakeRow | undefined> {
  return db.selectFrom("digifab_makes").select(["id", "name", "folder_id", "start_step", "created_by"]).where("id", "=", id).executeTakeFirst();
}

/** The model file a Make's Model step (or its Slice step, for G-code) holds. */
async function modelOf(orgId: string, db: Kysely<DigifabDB>, makeId: string): Promise<{ fileId: string; role: "stl" | "step" | "3mf" | "gcode"; report: unknown } | null> {
  const steps = await db.selectFrom("digifab_make_steps").select(["id", "step", "status", "data"]).where("make_id", "=", makeId).where("step", "in", ["model", "slice"]).execute();
  for (const want of ["slice", "model"] as const) {
    const step = steps.find((s) => s.step === want);
    if (!step || (want === "slice" && step.status !== "done")) continue;
    const files = (await platform().files.listAttachments(orgId, { source_module: "digifab", source_type: "make-step", source_id: step.id })) ?? [];
    for (const f of files) {
      const role = want === "model" ? (MODEL_ROLES.includes(f.role as MakeFileRole) ? (f.role as "stl" | "step" | "3mf") : roleOf(f.filename, f.mimeType)) : roleOf(f.filename, f.mimeType);
      if (want === "slice" && (role === "gcode" || role === "3mf")) return { fileId: f.fileId, role: "gcode", report: step.data.report ?? step.data.printer };
      if (want === "model" && role && role !== "gcode") return { fileId: f.fileId, role, report: (step.data as Record<string, unknown>)?.report };
    }
  }
  return null;
}

/** Start Print this: a Make, a printer, a slice. Sends nothing. */
export async function startPrintThis(orgId: string, userId: string | null, ask: PrintThisAsk): Promise<PrintThisResult> {
  if (ask.quantity != null && (!Number.isSafeInteger(ask.quantity) || ask.quantity < 1 || ask.quantity > 10000)) return { ok: false, code: "bad_quantity", error: "Choose a whole number of prints from 1 to 10000." };
  const material = ask.material?.trim();
  if (!material) return { ok: false, code: "no_material", error: "Say which material to print in (PLA, PETG, ...)." };
  const db = await tenantDb(orgId);
  if (ask.make_id) return db.transaction().execute(async (tx) => {
    await tx.selectFrom("digifab_makes").select("id").where("id", "=", ask.make_id!).forUpdate().executeTakeFirst();
    return preparePrintThis(tx, orgId, userId, ask, material);
  });
  return preparePrintThis(db, orgId, userId, ask, material);
}

async function preparePrintThis(db: Kysely<DigifabDB>, orgId: string, userId: string | null, ask: PrintThisAsk, material: string): Promise<PrintThisResult> {
  // 1. The Make and its model.
  let make: MakeRow | undefined;
  let created = false;
  let model: { fileId: string; role: "stl" | "step" | "3mf" | "gcode"; report: unknown } | null = null;
  if (ask.make_id) {
    make = await loadMake(db, ask.make_id);
    if (!make) return { ok: false, code: "not_found", error: "That Make was not found." };
    model = await modelOf(orgId, db, make.id);
    if (!model) return startDesign(db, orgId, userId, make, ask);
    const existing = await db.selectFrom("digifab_make_steps").select("id").where("make_id", "=", make.id).where("step", "in", model.role === "gcode" ? ["print"] : ["slice", "print"]).executeTakeFirst();
    if (existing) return { ok: false, code: "already_prepared", error: "This Make already has a slice or print. Make it again from that step to change it.", make_id: make.id };
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
  } else if (ask.prompt || ask.source || ask.template) {
    make = await db.insertInto("digifab_makes").values({ name: (ask.name?.trim() || ask.prompt?.trim() || "New part").slice(0, 200), prompt: ask.prompt ?? null, start_step: "request", created_by: userId }).returning(["id", "name", "folder_id", "start_step", "created_by"]).executeTakeFirstOrThrow();
    await recordMakeStep(db, orgId, userId, make, "request", { data: { prompt: ask.prompt ?? ask.name ?? "New part", origin: ask.origin ?? "page", requested_by: userId }, produced_by: { kind: "person" } });
    const result = await startDesign(db, orgId, userId, make, ask);
    return { ...result, created_make: true };
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
  const modelStep = await db.selectFrom("digifab_make_steps").select("data").where("make_id", "=", make.id).where("step", "=", "model").executeTakeFirst();
  const quantity = ask.quantity ?? Number((modelStep?.data as Record<string, unknown> | undefined)?.quantity ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000) return fail("bad_quantity", "Choose a whole number of prints from 1 to 10000.");
  const choice = { material, color: ask.color ?? null, quantity, printer, others: ranked.filter((p) => p !== best).slice(0, 4).map(brief) };

  // A G-code is already sliced: straight to the one yes.
  if (model.role === "gcode") {
    const sliceStep = await db.selectFrom("digifab_make_steps").selectAll().where("make_id", "=", make.id).where("step", "=", "slice").executeTakeFirst();
    const bytes = await platform().files.read(orgId, model.fileId, "original");
    const metadata = bytes ? extractPlateMetadata(bytes.filename, Buffer.from(bytes.bytes)) : {};
    const prior = (sliceStep?.data as Record<string, unknown> | undefined) ?? {};
    const gramsByTool = metadata.filament_g_by_tool ?? readGramsByTool(prior.grams_by_tool);
    const grams = metadata.filament_g ?? (gramsByTool ? gramsByTool.reduce((sum, g) => sum + g, 0) : typeof prior.total_grams === "number" ? prior.total_grams : null);
    const seconds = metadata.estimated_sec ?? (typeof prior.time_s === "number" ? prior.time_s : null);
    await recordMakeStep(db, orgId, userId, make, "slice", {
      data: { ...prior, ...choice, grams_by_tool: gramsByTool, time_s: seconds },
      produced_by: sliceStep?.produced_by ?? { kind: "upload" },
      service_job_id: sliceStep?.service_job_id,
      copied_from: sliceStep?.copied_from,
    });
    const ready = await readyToPrint(db, orgId, make, { gcodeFileId: model.fileId, choice, grams, gramsByTool, seconds, previewFileId: null });
    if (!ready.ok) return fail(ready.code, ready.error);
    return { ok: true, make_id: make.id, created_make: created, printer: { machine: printer.machine, reason: printer.reason }, slice_job_id: null, summary: `Ready to print on ${printer.machine ?? printer.device ?? "the printer"}. Confirm it on the Make.` };
  }

  // 3. The slice, for that printer's profile.
  const profile = best.profile;
  if (!profile?.printer_model || profile.nozzle_mm == null || !profile.quality) {
    return fail("no_profile", `${printer.machine ?? "The chosen printer"} has no Printing profile yet. Set its printer model, nozzle and quality on its page, then print this again.`);
  }
  const filament: Record<string, unknown> = { ...best.loaded?.values, material, ...(profile.preset_hint ? { preset_hint: profile.preset_hint } : {}) };
  const sliceInput = { printer_model: profile.printer_model, nozzle_mm: profile.nozzle_mm, quality: profile.quality, filament: [filament] };
  const sliceStepId = await recordMakeStep(db, orgId, userId, make, "slice", {
    status: "running",
    data: { ...choice, printer_model: profile.printer_model, nozzle_mm: profile.nozzle_mm, quality: profile.quality, invocation: { input: sliceInput, files: { model: model.fileId } } },
    produced_by: { kind: "service", capability: SLICE_CAPABILITY },
  });
  let job: { id: string; status: string };
  try {
    job = await platform().services.invoke({
      orgId,
      capability: SLICE_CAPABILITY,
      input: sliceInput,
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

  return {
    ok: true,
    make_id: make.id,
    created_make: created,
    printer: { machine: printer.machine, reason: printer.reason },
    slice_job_id: job.id,
    summary: `Slicing for ${printer.machine ?? printer.device ?? "the printer"} (${printer.reason}). The Make asks you before anything prints.`,
  };
}

async function startDesign(db: Kysely<DigifabDB>, orgId: string, userId: string | null, make: MakeRow, ask: PrintThisAsk): Promise<PrintThisResult> {
  const existing = await db.selectFrom("digifab_make_steps").select("id").where("make_id", "=", make.id).where("step", "=", "design").executeTakeFirst();
  if (existing) return { ok: false, code: "design_exists", error: "This Make already has a design. Make it again from Design to change it.", make_id: make.id };
  const request = await db.selectFrom("digifab_make_steps").select("data").where("make_id", "=", make.id).where("step", "=", "request").executeTakeFirst();
  const prompt = ask.prompt ?? (request?.data as Record<string, unknown> | undefined)?.prompt;
  const input = { ...(typeof prompt === "string" ? { prompt } : {}), ...(ask.source ? { source: ask.source, source_lang: ask.source_lang ?? "solidcraft" } : {}), ...(ask.template ? { template: ask.template } : {}), params: ask.params ?? {}, material: ask.material, units: "mm" };
  const id = await recordMakeStep(db, orgId, userId, make, "design", { status: "running", data: { input, invocation: { input }, material: ask.material, color: ask.color ?? null, quantity: ask.quantity ?? 1 }, produced_by: { kind: "service", capability: DESIGN_CAPABILITY } });
  try {
    const job = await platform().services.invoke({ orgId, capability: DESIGN_CAPABILITY, input, attachTo: { kind: "digifab:make-step", id }, idempotencyKey: `make-design:${make.id}:${id}` });
    await db.updateTable("digifab_make_steps").set({ service_job_id: job.id }).where("id", "=", id).execute();

    return { ok: true, make_id: make.id, created_make: false, printer: { machine: null, reason: "Review the model before choosing a printer." }, slice_job_id: job.id, summary: "Design started. Review the preview on the Make, then choose Print this to slice it." };
  } catch (err) {
    const error = (err as Error).message;
    await recordMakeStep(db, orgId, userId, make, "design", { status: "failed", data: { input }, produced_by: { kind: "service", capability: DESIGN_CAPABILITY }, error });
    return { ok: false, code: "design_refused", error: `The design could not start: ${error}`, make_id: make.id };
  }
}

export async function onDesignSettled(orgId: string, jobId: string): Promise<void> {
  const db = await tenantDb(orgId);
  await db.transaction().execute(async (tx) => {
    const step = await tx.selectFrom("digifab_make_steps").selectAll().where("step", "=", "design").where("service_job_id", "=", jobId).forUpdate().executeTakeFirst();
    if (!step || !["running", "done"].includes(step.status)) return;
    if (await tx.selectFrom("digifab_make_steps").select("id").where("make_id", "=", step.make_id).where("step", "=", "model").executeTakeFirst()) return;
    const make = await loadMake(tx, step.make_id);
    const job = await platform().services.job(orgId, jobId);
    if (!make || !job || !["done", "failed", "cancelled"].includes(job.status)) return;
    const prior = (step.data ?? {}) as Record<string, unknown>;
    const output = (job.output ?? {}) as Record<string, unknown>;
    const by = { kind: "service", capability: DESIGN_CAPABILITY, connection_id: job.connection_id, version: job.service_version, job_id: job.id };
    if (job.status !== "done") {
      await recordMakeStep(tx, orgId, null, make, "design", { status: "failed", service_job_id: jobId, data: prior, produced_by: by, error: job.error?.message ?? "The design was stopped." });
      return;
    }
    const files = job.files.filter((f) => f.direction === "out").map((f) => ({ file_id: f.file_id, role: (["source", "step", "stl", "3mf", "preview", "report"].includes(f.name) ? f.name : "other") as MakeFileRole }));
    if (!files.some((f) => ["stl", "step", "3mf"].includes(f.role))) {
      await recordMakeStep(tx, orgId, null, make, "design", { status: "failed", service_job_id: jobId, data: prior, produced_by: by, error: "The design finished without a model to review." });
      return;
    }
    await recordMakeStep(tx, orgId, null, make, "design", { data: { ...prior, ...output, parameters: output.params }, produced_by: by, service_job_id: jobId, files: files.filter((f) => f.role === "source" || f.role === "other") });
    await recordMakeStep(tx, orgId, null, make, "model", { data: { report: output.report, material: prior.material, color: prior.color, quantity: prior.quantity ?? 1 }, produced_by: by, service_job_id: jobId, files: files.filter((f) => f.role !== "source" && f.role !== "other") });
  });
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
  await db.transaction().execute(async (tx) => settleSlice(tx, orgId, jobId));
}

async function settleSlice(db: Kysely<DigifabDB>, orgId: string, jobId: string): Promise<void> {
  const step = await db
    .selectFrom("digifab_make_steps")
    .select(["id", "make_id", "status", "data"])
    .where("service_job_id", "=", jobId)
    .where("step", "=", "slice")
    .forUpdate()
    .executeTakeFirst();
  if (!step || (step.status !== "running" && step.status !== "done")) return;
  const print = await db.selectFrom("digifab_make_steps").select("id").where("make_id", "=", step.make_id).where("step", "=", "print").executeTakeFirst();
  if (print) return;
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
  for (const f of outFiles) {
    const stored = await platform().files.read(orgId, f.file_id, "original");
    const role: MakeFileRole = f.name === "preview" ? "preview" : stored && roleOf(stored.filename, stored.mimeType) === "3mf" ? "3mf" : f.name === "gcode" || f.name === "plain_gcode" ? "gcode" : f.name === "settings" ? "settings" : "other";
    files.push({ file_id: f.file_id, role });
  }
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
  const choice = prior as { printer?: Record<string, unknown>; material?: string; quantity?: number };
  await readyToPrint(db, orgId, make, { gcodeFileId: gcode.file_id, choice, grams: total, gramsByTool: grams, seconds, previewFileId: preview?.file_id ?? null });
}

function sliceName(output: unknown): string | null {
  const s = (output as { slicer?: { name?: unknown } } | null)?.slicer;
  return typeof s?.name === "string" ? s.name : null;
}
function sliceVersion(output: unknown): string | null {
  const s = (output as { slicer?: { version?: unknown } } | null)?.slicer;
  return typeof s?.version === "string" ? s.version : null;
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
  o: { gcodeFileId: string; choice: { printer?: Record<string, unknown>; material?: string | null; quantity?: number }; grams: number | null; gramsByTool?: number[] | null; seconds: number | null; previewFileId: string | null },
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
      material_grams_by_tool: o.gramsByTool ? JSON.stringify(o.gramsByTool) : null,
      make_id: make.id,
      make_ordinal: (o.choice.quantity ?? 1) > 1 ? 1 : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await platform().activity.log({ orgId, userId: null, action: "job_created", ref: { module: "digifab", entityType: "job", entityId: job.id }, diff: { name: file?.filename ?? make.name, make: make.id } });
  const card = {
      printer: p.machine ?? p.device ?? null,
      machine_id: p.machine_id ?? null,
      spool: p.spool?.name ?? null,
      slot: p.spool?.slot ?? null,
      grams: o.grams,
      time_s: o.seconds,
      preview_file_id: o.previewFileId,
      spool_id: p.spool?.id ?? null,
  };
  const batch = (o.choice.quantity ?? 1) > 1 ? await prepareBatch(db, orgId, job, card, o.choice.quantity!) : null;
  await recordMakeStep(db, orgId, null, make, "print", {
    status: "awaiting_confirm", job_id: job.id,
    data: batch ? { ...card, batch, confirm_hash: batch.review_hash } : { ...card, confirm_hash: printHash(job, card, file?.bytes) },
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
  const recordLink = await platform().entities.recordAddressForEntity(orgId, MAKE_KIND, make.id);
  await Promise.all(
    to.map((userId) =>
      platform()
        // dispatch-per-row-ok: one message to each person told about this one Make, never one per record
        .notifications.dispatch({ orgId, userId, eventType: "digifab.make.ready", message, ...(recordLink ? { link_url: recordLink } : { no_link_reason: "the make has no detail page" }), module: "digifab", entityType: MAKE_KIND, entityId: make.id })
        .catch((err: unknown) => console.warn(`[digifab] make ${make.id}: ready notice not sent: ${(err as Error).message}`)),
    ),
  );
}

function printHash(job: Record<string, unknown>, data: Record<string, unknown>, bytes?: Uint8Array): string {
  const { confirm_hash: _hash, ...card } = data;
  const fields = ["id", "connection_id", "target_device", "target_pool", "file_id", "file_ref", "linked_machine_id", "material_part_id", "material_grams", "material_type", "material_grams_by_tool"];
  return createHash("sha256").update(canonicalJson({ card, job: Object.fromEntries(fields.map((k) => [k, job[k] ?? null])), file: bytes ? createHash("sha256").update(bytes).digest("hex") : null })).digest("hex");
}

export async function recoverPrintThis(orgId: string, db: Kysely<DigifabDB>): Promise<void> {
  await recoverBatches(db, orgId);
  for (const [stage, next] of [["design", "model"], ["slice", "print"]] as const) {
    const pending = await db.selectFrom("digifab_make_steps as pending").select(["pending.id", "pending.make_id", "pending.step", "pending.status", "pending.data", "pending.service_job_id"])
      .where("pending.step", "=", stage).where("pending.status", "in", ["running", "done"])
      .where((eb) => eb.not(eb.exists(eb.selectFrom("digifab_make_steps as following").select("following.id").whereRef("following.make_id", "=", "pending.make_id").where("following.step", "=", next))))
      .limit(100).execute();
    for (const step of pending) {
      try {
        let jobId = step.service_job_id;
        if (!jobId && step.status === "running") {
          const invocation = (step.data as { invocation?: { input: unknown; files?: Record<string, string> } }).invocation;
          if (!invocation) continue;
          const ref = await platform().services.invoke({ orgId, capability: stage === "design" ? DESIGN_CAPABILITY : SLICE_CAPABILITY, ...invocation, attachTo: { kind: "digifab:make-step", id: step.id }, idempotencyKey: stage === "design" ? `make-design:${step.make_id}:${step.id}` : `print-this:${step.make_id}:${step.id}` });
          jobId = ref.id;
          await db.updateTable("digifab_make_steps").set({ service_job_id: jobId }).where("id", "=", step.id).where("service_job_id", "is", null).execute();
        }
        if (!jobId) continue;
        if (stage === "design") await onDesignSettled(orgId, jobId);
        else await onSliceSettled(orgId, jobId);
      } catch (err) {
        console.warn(`[digifab] make step ${step.id} could not resume: ${(err as Error).message}`);
      }
    }
  }
}

/** The one yes: send the Make's waiting print. A person's press on the Make's
 *  card, and nothing else, reaches here. */
export async function startPrint(orgId: string, userId: string | null, makeId: string, confirmHash?: string): Promise<{ ok: true; status: string } | { ok: false; code: string; error: string }> {
  if (!userId) return { ok: false, code: "person_required", error: "A person must confirm the print in Cobblr." };
  const db = await tenantDb(orgId);
  const make = await loadMake(db, makeId);
  if (!make) return { ok: false, code: "not_found", error: "Make not found." };
  const step = await db.selectFrom("digifab_make_steps").select(["status", "job_id", "data"]).where("make_id", "=", makeId).where("step", "=", "print").executeTakeFirst();
  if (!step?.job_id) return { ok: false, code: "nothing_waiting", error: "This Make has no print waiting to start." };
  if (step.status !== "awaiting_confirm") return { ok: false, code: "already_started", error: "This print has already been started." };
  const card = (step.data ?? {}) as Record<string, unknown>;
  if (card.batch) return startBatchPrint(db, orgId, userId, makeId, confirmHash);
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", step.job_id).executeTakeFirst();
  const file = job?.file_id ? await platform().files.read(orgId, job.file_id, "original") : null;
  if (!job || !file || !confirmHash || card.confirm_hash !== confirmHash || printHash(job, card, file.bytes) !== confirmHash) {
    return { ok: false, code: "print_changed", error: "This print changed after its card was prepared. Run Print this on a new Make to review it again." };
  }
  if (typeof card.spool_id === "string" && typeof card.machine_id === "string") {
    const loaded = await platform().placement.contents({ orgId, container: { kind: "machines:machine", id: card.machine_id } });
    if (!loaded.some((s) => s.id === card.spool_id && s.slot === card.slot)) return { ok: false, code: "spool_changed", error: "The spool shown is no longer loaded in that slot. Prepare this print again." };
  }
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
  const batchHandler = (operation: "next" | "review" | "cancel"): ActionHandler => async ctx => {
    const actionId = operation === "next" ? "digifab:start-next-print" : operation === "review" ? "digifab:review-print-batch" : "digifab:cancel-print-batch";
    if (!ctx.userId || !await platform().auth.userMayRun({ orgId: ctx.orgId, userId: ctx.userId, actionId })) return { ok: false, error: operation === "cancel" ? "A workspace member cancels the remaining prints." : operation === "next" ? "An admin or an operator starts the next print." : "An owner or admin manages this batch." };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const makeId = typeof args.make_id === "string" ? args.make_id : ctx.entity?.kind === MAKE_KIND ? ctx.entity.id : null;
    if (!makeId) return { ok: false, error: "Say which Make's batch to use." };
    const db = await tenantDb(ctx.orgId);
    if (operation === "next") return startBatchPrint(db, ctx.orgId, ctx.userId, makeId, undefined, true);
    const { reviewBatch, cancelBatch } = await import("./print-batch.js");
    return operation === "review" ? reviewBatch(db, ctx.orgId, makeId, typeof args.quantity === "number" ? args.quantity : undefined) : cancelBatch(db, makeId);
  };
  platform().actions.registerHandler("digifab.start-next-print", batchHandler("next"));
  platform().actions.registerHandler("digifab.review-print-batch", batchHandler("review"));
  platform().actions.registerHandler("digifab.cancel-print-batch", batchHandler("cancel"));
  const settled = async (payload: unknown) => {
    const p = payload as { orgId?: string; jobId?: string; capability?: string };
    if (!p.orgId || !p.jobId || ![SLICE_CAPABILITY, DESIGN_CAPABILITY].includes(p.capability ?? "")) return;
    try {
      if (p.capability === DESIGN_CAPABILITY) await onDesignSettled(p.orgId, p.jobId);
      else await onSliceSettled(p.orgId, p.jobId);
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
      prompt: typeof a.prompt === "string" ? a.prompt : undefined,
      // A SolidCraft script is JSON, and a model may pass it as an object.
      source: typeof a.source === "string" ? a.source : a.source && typeof a.source === "object" ? JSON.stringify(a.source) : undefined,
      source_lang: a.source_lang === "openscad" ? "openscad" : "solidcraft",
      template: typeof a.template === "string" ? a.template : undefined,
      quantity: typeof a.quantity === "number" ? a.quantity : undefined,
      params: a.params && typeof a.params === "object" && !Array.isArray(a.params) ? a.params as Record<string, unknown> : undefined,
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
