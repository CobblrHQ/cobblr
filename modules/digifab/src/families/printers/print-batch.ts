import { createHash } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { canonicalJson } from "@cobblr/platform-contract/service-consent";
import type { DigifabDB } from "../../db.js";
import { permitBatchStart } from "../../batch-start-permit.js";
import { sendAndWatch } from "../../api/jobs.js";
import { buildDriverById, markJobTerminal, recordJobOutcome, NOT_OCCUPYING_STATUSES } from "../../jobs-core.js";
import { linkPrint } from "../../makes-core.js";
import { classify } from "../../state.js";
import { filamentValues } from "./slicer-filament.js";

type Job = Selectable<DigifabDB["digifab_jobs"]>;
type Approval = { hash: string; by: string; at: string };
type Start = { job_id: string; ordinal: number; approval: string; by: string; at: string; status: string };
export interface PrintBatch {
  quantity: number;
  completed: number;
  state: "review" | "running" | "waiting_bed" | "changed" | "needs_approval" | "complete" | "cancelled" | "failed";
  review_hash: string;
  facts: Record<string, unknown>;
  approvals: Approval[];
  starts: Start[];
  settled: Array<{ job_id: string; ordinal: number; status: string }>;
}
type Result = { ok: true; status: string } | { ok: false; code: string; error: string };
const refused = (code: string, error: string): Result => ({ ok: false, code, error });
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const contentHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const JOB_FACTS = ["connection_id", "target_device", "target_pool", "file_id", "file_ref", "linked_machine_id", "material_part_id", "material_grams", "material_type", "material_grams_by_tool"] as const;

async function factsFor(db: Kysely<DigifabDB>, orgId: string, job: Job, card: Record<string, unknown>, quantity: number): Promise<Record<string, unknown>> {
  const file = job.file_id ? await platform().files.read(orgId, job.file_id, "original") : null;
  if (!file) throw new Error("The batch's print file is no longer available.");
  const preview = typeof card.preview_file_id === "string" ? await platform().files.read(orgId, card.preview_file_id, "original") : null;
  const connection = job.connection_id ? await platform().devices.connections().getInternal(orgId, job.connection_id) : null;
  const link = job.connection_id && job.target_device ? await db.selectFrom("digifab_device_links").select("machine_id").where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device).executeTakeFirst() : null;
  const profile = job.linked_machine_id ? await db.selectFrom("digifab_printing_profiles").selectAll().where("machine_id", "=", job.linked_machine_id).executeTakeFirst() : null;
  const contents = job.linked_machine_id ? await platform().placement.contents({ orgId, container: { kind: "machines:machine", id: job.linked_machine_id } }) : [];
  const spools: Record<string, unknown>[] = [];
  for (const spool of contents.filter(s => typeof s.slot === "string" && /^\d+$/.test(s.slot))) {
    const snapshot = await platform().entities.snapshot(orgId, spool.kind, spool.id);
    if (!snapshot) throw new Error("A loaded spool's material could not be checked.");
    const types = await platform().pairings.findBySources({ orgId, sourceKind: spool.kind, sourceIds: [spool.id], targetKind: spool.kind, relationshipKind: "instance-of" });
    const type = types[0]?.targetId ? await platform().entities.snapshot(orgId, spool.kind, types[0].targetId) : null;
    const metadata = { ...((type?.metadata ?? {}) as Record<string, unknown>), ...((snapshot.metadata ?? {}) as Record<string, unknown>) };
    const material = { ...filamentValues(metadata, snapshot.manufacturer ?? type?.manufacturer), material: metadata.material ?? null, preset_hint: metadata.preset_hint ?? null, type_id: types[0]?.targetId ?? null };
    spools.push({ kind: spool.kind, id: spool.id, slot: spool.slot, name: snapshot.name ?? null, material });
  }
  spools.sort((a,b) => String(a.slot).localeCompare(String(b.slot)) || String(a.id).localeCompare(String(b.id)));
  return {
    quantity, job: Object.fromEntries(JOB_FACTS.map(key => [key, job[key] ?? null])),
    card: Object.fromEntries(["printer", "spool", "slot", "grams", "time_s", "preview_file_id", "spool_id", "machine_id"].map(key => [key, card[key] ?? null])),
    file_name: file.filename, file_hash: contentHash(file.bytes), preview_hash: preview ? contentHash(preview.bytes) : null,
    connection: connection ? { type: connection.type, base_url: connection.base_url, credentials_hash: hash(connection.credentials_enc ?? null) } : null,
    mapped_machine: link?.machine_id ?? null,
    profile: profile ? { printer_model: profile.printer_model, nozzle_mm: profile.nozzle_mm, build_volume_mm: profile.build_volume_mm, default_quality: profile.default_quality, preset_hints: profile.preset_hints } : null,
    spools,
  };
}

export async function prepareBatch(db: Kysely<DigifabDB>, orgId: string, job: Job, card: Record<string, unknown>, quantity: number): Promise<PrintBatch> {
  const facts = await factsFor(db, orgId, job, card, quantity);
  return { quantity, completed: 0, state: "review", review_hash: hash(facts), facts, approvals: [], starts: [], settled: [] };
}

async function stepFor(db: Kysely<DigifabDB>, makeId: string) {
  return db.selectFrom("digifab_make_steps").selectAll().where("make_id", "=", makeId).where("step", "=", "print").forUpdate().executeTakeFirst();
}
function batchOf(data: Record<string, unknown>): PrintBatch | null {
  const batch = data.batch as PrintBatch | undefined;
  return batch && Number.isSafeInteger(batch.quantity) && batch.quantity >= 1 && batch.quantity <= 10000 && Array.isArray(batch.starts) && Array.isArray(batch.approvals) && Array.isArray(batch.settled) ? batch : null;
}
async function save(db: Kysely<DigifabDB>, id: string, data: Record<string, unknown>, batch: PrintBatch, status: string, error: string | null = null, jobId?: string) {
  await db.updateTable("digifab_make_steps").set({ data: JSON.stringify({ ...data, batch, confirm_hash: batch.review_hash }), status, error, updated_at: new Date(), ...(jobId ? { job_id: jobId } : {}) }).where("id", "=", id).execute();
}

export async function reviewBatch(db: Kysely<DigifabDB>, orgId: string, makeId: string, quantity?: number): Promise<Result> {
  return db.transaction().execute(async tx => {
    const step = await stepFor(tx, makeId);
    const data = step?.data ?? {};
    const batch = batchOf(data);
    if (!step?.job_id || !batch) return refused("not_found", "No print batch was found.");
    if (step.status === "running" || ["cancelled", "complete"].includes(batch.state)) return refused("not_waiting", "This batch is not waiting for review.");
    const job = await tx.selectFrom("digifab_jobs").selectAll().where("id", "=", step.job_id).executeTakeFirstOrThrow();
    if (job.status !== "queued") return refused("not_waiting", "The printer is already handling this job.");
    if (quantity != null) {
      if (!Number.isSafeInteger(quantity) || quantity <= batch.completed || quantity > 10000) return refused("bad_quantity", "The batch needs a whole total greater than the number already printed, up to 10000.");
      batch.quantity = quantity;
    }
    const currentFacts = await factsFor(tx, orgId, job, data, batch.quantity);
    const spools = currentFacts.spools as Array<{ id: string; name: string | null; slot: string; material: { material?: unknown } }>;
    const selected = spools.find(spool => spool.slot === data.slot);
    if (job.material_part_id) {
      if (!selected) return refused("spool_required", "Load the spool for this print before reviewing the batch.");
      if (job.material_type && String(selected.material.material ?? "").toLowerCase() !== job.material_type.toLowerCase()) return refused("material_changed", "Slice a new Make for the changed material before approving it.");
      job.material_part_id = selected.id;
      await tx.updateTable("digifab_jobs").set({ material_part_id: selected.id }).where("id", "=", job.id).execute();
      data.spool_id = selected.id;
      data.spool = selected.name;
    }
    if (job.linked_machine_id) data.printer = await platform().entities.titleForEntity(orgId, "machines:machine", job.linked_machine_id);
    batch.facts = await factsFor(tx, orgId, job, data, batch.quantity);
    batch.review_hash = hash(batch.facts);
    batch.state = "needs_approval";
    await save(tx, step.id, data, batch, "awaiting_confirm");
    return { ok: true, status: "awaiting_confirm" };
  });
}

export async function startBatchPrint(db: Kysely<DigifabDB>, orgId: string, userId: string | null, makeId: string, confirmHash?: string, bedClear = false): Promise<Result> {
  if (!userId || !await platform().auth.userHasRole({ orgId, userId, minRole: "admin" })) return refused("person_required", "An owner or admin must confirm this print.");
  const initial = await db.selectFrom("digifab_make_steps").select("job_id").where("make_id", "=", makeId).where("step", "=", "print").executeTakeFirst();
  const job = initial?.job_id ? await db.selectFrom("digifab_jobs").selectAll().where("id", "=", initial.job_id).executeTakeFirst() : null;
  if (!job?.connection_id || !job.target_device) return refused("not_found", "No printer was found for this batch.");
  let result: Result = refused("printer_busy", "Another print is being prepared for this printer.");
  const lock = await platform().exclusive.run(`print-batch:${orgId}:${job.connection_id}:${job.target_device}`, async () => {
    result = await startLocked(db, orgId, userId, makeId, confirmHash, bedClear);
  });
  return lock.ran ? result : refused("printer_busy", "Another print is being prepared for this printer.");
}

async function startLocked(db: Kysely<DigifabDB>, orgId: string, userId: string, makeId: string, confirmHash: string | undefined, bedClear: boolean): Promise<Result> {
  const claim = await db.transaction().execute(async tx => {
    const step = await stepFor(tx, makeId);
    const data = step?.data ?? {};
    const batch = batchOf(data);
    if (!step?.job_id || !batch) return { error: refused("not_found", "No print batch was found.") };
    if (step.status !== "awaiting_confirm" || ["complete", "cancelled", "failed"].includes(batch.state)) return { error: refused("not_waiting", "This batch is not waiting to start.") };
    const job = await tx.selectFrom("digifab_jobs").selectAll().where("id", "=", step.job_id).executeTakeFirstOrThrow();
    const facts = await factsFor(tx, orgId, job, data, batch.quantity);
    if (hash(facts) !== batch.review_hash || hash(batch.facts) !== batch.review_hash || data.confirm_hash !== batch.review_hash) {
      batch.state = "changed";
      const error = "The printer, file, spool, material or quantity changed. Review and approve the batch again.";
      await save(tx, step.id, data, batch, "awaiting_confirm", error);
      return { error: refused("batch_changed", error) };
    }
    if (batch.state === "review" || batch.state === "needs_approval") {
      if (confirmHash !== batch.review_hash) return { error: refused("approval_required", "Review and approve the batch before starting.") };
      batch.approvals.push({ hash: batch.review_hash, by: userId, at: new Date().toISOString() });
    }
    if (batch.state === "changed") return { error: refused("approval_required", "Review and approve the batch again before starting.") };
    if (batch.settled.length && !bedClear) return { error: refused("bed_clear_required", "Clear the bed, then start the next print.") };
    const previous = batch.settled.at(-1);
    const attention = await tx.selectFrom("digifab_device_attention").selectAll().where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device).executeTakeFirst();
    if (attention && (!previous || attention.job_id !== previous.job_id)) return { error: refused("bed_busy", "Another job needs this printer's bed check.") };
    const busy = await tx.selectFrom("digifab_jobs").select("id").where("connection_id", "=", job.connection_id).where("target_device", "=", job.target_device).where("id", "!=", job.id).where("status", "not in", [...NOT_OCCUPYING_STATUSES]).executeTakeFirst();
    const uploading = await tx.selectFrom("digifab_jobs").select("id").where("connection_id", "=", job.connection_id).where("target_device", "=", job.target_device).where("id", "!=", job.id).where("send_token", "is not", null).executeTakeFirst();
    if (busy || uploading) return { error: refused("printer_busy", "This printer is already handling another print.") };
    try {
      const driver = await buildDriverById(tx, orgId, job.connection_id!);
      const device = (await driver?.listDevices())?.find(d => d.id === job.target_device);
      const state = classify(device?.state ?? "");
      if (!device?.enabled || (state !== "idle" && !(previous && bedClear && state === "complete"))) return { error: refused("printer_busy", "The printer must be idle and reachable before starting.") };
    } catch {
      return { error: refused("printer_busy", "The printer could not be checked. Try again when it is reachable.") };
    }
    batch.state = "running";
    batch.starts.push({ job_id: job.id, ordinal: job.make_ordinal!, approval: batch.review_hash, by: userId, at: new Date().toISOString(), status: "starting" });
    await save(tx, step.id, data, batch, "running");
    return { job, previous };
  });
  if ("error" in claim) return claim.error!;
  const { job, previous } = claim;
  let result: Awaited<ReturnType<typeof sendAndWatch>>;
  try {
  if (previous) {
    const priorJob = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", previous.job_id).executeTakeFirstOrThrow();
    if (!priorJob.outcome_at) {
      await recordJobOutcome(db, orgId, priorJob.id, "good", "bed-clear");
      await platform().events.emit("digifab.print.confirmed", { orgId, jobId: priorJob.id, linkedTaskId: priorJob.linked_task_id, linkedMachineId: priorJob.linked_machine_id });
    }
    await db.deleteFrom("digifab_device_attention").where("connection_id", "=", job.connection_id).where("remote_device_id", "=", job.target_device).where("job_id", "=", previous.job_id).execute();
  }
  result = await sendAndWatch(db, orgId, job.id, undefined, permitBatchStart(job.id));
  } catch (error) {
    result = { ok: false, code: "send_failed", message: error instanceof Error ? error.message : "The printer could not be reached." };
  }
  await db.transaction().execute(async tx => {
    const step = await stepFor(tx, makeId);
    if (!step || step.job_id !== job.id) return;
    const batch = batchOf(step.data)!;
    if (batch.settled.some(settled => settled.job_id === job.id)) return;
    const start = batch.starts.at(-1)!;
    start.status = result.ok ? "sent" : "refused";
    if (!result.ok && batch.state !== "cancelled") batch.state = batch.settled.length ? "waiting_bed" : "review";
    if (!result.ok && batch.state === "cancelled") {
      const waiting = await tx.selectFrom("digifab_jobs").selectAll().where("id", "=", job.id).executeTakeFirst();
      if (waiting?.status === "queued" && !waiting.remote_job_id && !waiting.send_token) await markJobTerminal(tx, waiting, "cancelled", { error: "The remaining batch prints were cancelled." });
    }
    await save(tx, step.id, step.data, batch, result.ok ? "running" : batch.state === "cancelled" ? "done" : "awaiting_confirm", result.ok ? null : result.message);
  });
  if (result.ok) await linkPrint(db, orgId, makeId, job.id, userId);
  return result.ok ? { ok: true, status: result.status } : refused(result.code, result.message);
}

export async function settleBatchForJob(db: Kysely<DigifabDB>, orgId: string, jobId: string, status: "completed" | "failed" | "cancelled"): Promise<boolean> {
  const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job?.make_id || !job.make_ordinal) return false;
  await db.transaction().execute(async tx => {
    const step = await stepFor(tx, job.make_id!);
    if (!step || step.job_id !== job.id) return;
    const batch = batchOf(step.data);
    if (!batch || batch.settled.some(s => s.job_id === job.id)) return;
    batch.settled.push({ job_id: job.id, ordinal: job.make_ordinal!, status });
    for (const start of batch.starts.filter(s => s.job_id === job.id && s.status !== "refused")) start.status = status;
    if (status === "completed") batch.completed++;
    if (batch.state === "cancelled" || status !== "completed" || batch.completed >= batch.quantity) {
      if (batch.state !== "cancelled") batch.state = status === "completed" ? "complete" : "failed";
      await save(tx, step.id, step.data, batch, status === "completed" ? "done" : "failed", status === "completed" ? null : "The batch stopped after this print.");
      return;
    }
    const next = await tx.insertInto("digifab_jobs").values({
      make_id: job.make_id, make_ordinal: job.make_ordinal! + 1,
      connection_id: job.connection_id, target_device: job.target_device, target_pool: null,
      file_id: job.file_id, file_ref: job.file_ref, linked_machine_id: job.linked_machine_id,
      material_part_id: job.material_part_id, material_grams: job.material_grams, material_type: job.material_type,
      material_grams_by_tool: job.material_grams_by_tool == null ? null : JSON.stringify(job.material_grams_by_tool),
    }).returningAll().executeTakeFirstOrThrow();
    batch.state = "waiting_bed";
    await save(tx, step.id, step.data, batch, "awaiting_confirm", null, next.id);
  });
  await linkPrint(db, orgId, job.make_id, job.id, null);
  return true;
}

export async function cancelBatch(db: Kysely<DigifabDB>, makeId: string): Promise<Result> {
  return db.transaction().execute(async tx => {
    const step = await stepFor(tx, makeId);
    const batch = step ? batchOf(step.data) : null;
    if (!step || !batch) return refused("not_found", "No print batch was found.");
    if (batch.state === "complete") return { ok: true, status: "complete" };
    batch.state = "cancelled";
    if (step.status !== "running" && step.job_id) {
      const job = await tx.selectFrom("digifab_jobs").selectAll().where("id", "=", step.job_id).executeTakeFirst();
      if (job && job.status === "queued") await markJobTerminal(tx, job, "cancelled", { error: "The remaining batch prints were cancelled." });
    }
    await save(tx, step.id, step.data, batch, step.status === "running" ? "running" : "done");
    return { ok: true, status: "cancelled" };
  });
}

export async function recoverBatches(db: Kysely<DigifabDB>, orgId: string): Promise<void> {
  const pending = await db.selectFrom("digifab_make_steps").selectAll().where("step", "=", "print").where("status", "=", "running").limit(100).execute();
  for (const step of pending) {
    if (!step.job_id || !batchOf(step.data)) continue;
    try {
      const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", step.job_id).executeTakeFirst();
      if (!job) continue;
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        await settleBatchForJob(db, orgId, job.id, job.status);
        continue;
      }
      await db.transaction().execute(async tx => {
        const current = await stepFor(tx, step.make_id);
        const batch = current ? batchOf(current.data) : null;
        const start = batch?.starts.at(-1);
        const freshJob = await tx.selectFrom("digifab_jobs").selectAll().where("id", "=", job.id).executeTakeFirst();
        if (!current || current.job_id !== job.id || current.status !== "running" || !batch || start?.status !== "starting" || Date.parse(start.at) > Date.now() - 300000 || freshJob?.status !== "queued" || freshJob.send_token || freshJob.remote_job_id || freshJob.remote_file_id) return;
        start.status = "interrupted";
        if (batch.state === "cancelled") {
          await markJobTerminal(tx, freshJob, "cancelled", { error: "The remaining batch prints were cancelled." });
          await save(tx, current.id, current.data, batch, "done");
        } else {
          batch.state = "needs_approval";
          await save(tx, current.id, current.data, batch, "awaiting_confirm", "The start was interrupted. Review the batch and confirm again.");
        }
      });
    } catch (error) {
      console.warn(`[digifab] print batch ${step.make_id} could not resume: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
