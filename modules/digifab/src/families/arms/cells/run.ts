// Running a cell's job: Cobblr starts it once at the cell's station, the
// bridge runs every step, and Cobblr records what the bridge reports. A
// start is a person's check at the cell bound to the job and each arm's
// tooling; a lost answer is reconciled by reading the cell, never by
// starting again; Stop goes from anyone, whatever the cell reports. While a
// job is open its machines are held: nothing else in Cobblr starts them.
import "./db.js";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { actionActed } from "@cobblr/platform-contract/action-result";
import type { CellEventPage, CellState } from "@cobblr/platform-contract/robot-cell";
import type { DigifabDB } from "../../../db.js";
import { buildDriverById } from "../../../jobs-core.js";
import { authorizeArm, ArmRefusal } from "../station.js";
import { armDriver, machineRef } from "../store.js";
import { cellDriver, cellMembers, requireCell, startPlan } from "./store.js";

type Job = Selectable<DigifabDB["digifab_cell_jobs"]>;
type Cell = Selectable<DigifabDB["digifab_cells"]>;
export interface CellActor { userId: string | null; via: "page" | "station" | "assistant"; admin: boolean }
const Token = z.string().min(32).max(128);
const UNANSWERED = "The bridge did not confirm the command. Check the cell before trying again; Cobblr never resends it.";

async function connected(db: Kysely<DigifabDB>, machineId: string) {
  const cell = await requireCell(db, machineId);
  if (!cell.connection_id || !cell.device_id) throw new ArmRefusal("This cell is not on your bridge yet. Choose its connection first.");
  return cell as Cell & { connection_id: string; device_id: string };
}

async function record(db: Kysely<DigifabDB>, orgId: string, cellId: string, operation: "start" | "resume" | "stop", jobId: string | null, actor: CellActor, ok: boolean, detail: string) {
  await db.insertInto("digifab_cell_commands").values({ cell_id: cellId, operation, job_id: jobId, user_id: actor.userId, via: actor.via, ok, detail }).execute();
  await platform().activity.log({ orgId, userId: actor.userId, action: "cell_command", ref: machineRef(cellId), diff: { operation, job: jobId, via: actor.via, ok, ...(detail ? { detail } : {}) } });
}

/** Whether this person runs this cell: an owner or admin, or one of its
 *  operators (any operator when it names none). */
function operatorRefusal(cell: Cell, actor: CellActor): string | null {
  if (actor.admin || !cell.operators.length) return null;
  return actor.userId && cell.operators.includes(actor.userId) ? null : "This cell is run by its operators. Ask one of them, or an admin.";
}

/** Everything that must be true of the cell's machines before it starts:
 *  each arm in service, its programs on its controller, no run of its own
 *  and no station holding it; each machine answering on the bridge. */
async function machinesReady(db: Kysely<DigifabDB>, orgId: string, cell: Cell): Promise<void> {
  const members = await cellMembers(db, cell.machine_id);
  const steps = (cell.definition.steps ?? []);
  for (const m of members) {
    if (m.kind === "arm") {
      const unit = await db.selectFrom("digifab_arm_units").select(["maintenance"]).where("machine_id", "=", m.machine_id!).executeTakeFirst();
      if (unit?.maintenance === "down-for-repair") throw new ArmRefusal(`${m.role} is down for repair.`);
      if (await db.selectFrom("digifab_arm_runs").select("id").where("machine_id", "=", m.machine_id!).where("status", "<>", "ended").executeTakeFirst()) throw new ArmRefusal(`${m.role} has a run of its own open. End it first.`);
      if (await db.selectFrom("digifab_arm_ownership").select("machine_id").where("machine_id", "=", m.machine_id!).where("released_at", "is", null).where("expires_at", ">", new Date()).executeTakeFirst()) throw new ArmRefusal(`A station has control of ${m.role}. Give back its control first.`);
      for (const step of steps) {
        if (step.kind !== "arm-program" || step.role !== m.role) continue;
        const program = await db.selectFrom("digifab_arm_programs").select(["missing_since", "released_at"]).where("machine_id", "=", m.machine_id!).where("name", "=", step.program.name).where((eb) => step.program.revision === null ? eb("revision", "is", null) : eb("revision", "=", step.program.revision)).executeTakeFirst();
        if (!program || program.missing_since) throw new ArmRefusal(`${m.role}'s controller no longer holds ${step.program.name} at that revision. Read its programs again.`);
        if (!program.released_at) throw new ArmRefusal(`${step.program.name} on ${m.role} is not released for production. Review what changed in it and release it first.`);
      }
      let state;
      try { state = await (await armDriver(db, orgId, m.connection_id)).state(m.device_id); }
      catch { throw new ArmRefusal(`${m.role} did not answer. Check it at the cell.`); }
      if (state.mode !== "remote") throw new ArmRefusal(`${m.role} is in local mode: the pendant has control.`);
      if (state.safety !== "normal") throw new ArmRefusal(`${m.role} reports ${state.safety.replace(/-/g, " ")}. Clear it at the pendant after checking the cell.`);
    } else if (m.kind === "machine") {
      try { await (await buildDriverById(db, orgId, m.connection_id))?.listDevices(); }
      catch { throw new ArmRefusal(`${m.role} did not answer. Check it at the cell.`); }
    }
  }
}

export const StartCellSchema = z.object({ station_token: Token, definition_hash: z.string().min(16).max(64), cell_clear: z.literal(true) });
/** Start the cell's job: a person at its station, who checked the cell is
 *  clear and saw this exact job. Start is sent once. */
export async function startCellJob(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, actor: CellActor & { userId: string }) {
  const input = StartCellSchema.parse(value);
  const cell = await connected(db, machineId);
  const permit = await authorizeArm(db, cell.connection_id, cell.device_id, input.station_token);
  const refused = operatorRefusal(cell, actor);
  if (refused) throw new ArmRefusal(refused);
  const plan = await startPlan(db, orgId, cell, await cellMembers(db, machineId)).catch((e) => { throw e instanceof ArmRefusal ? e : new ArmRefusal("Give the cell its machines and at least one step before starting it."); });
  if (plan.hash !== input.definition_hash) throw new ArmRefusal("The cell's job or an arm's tooling changed since this screen showed it. Check it again before starting.");
  await machinesReady(db, orgId, cell);
  const job = await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`digifab-cell-job:${machineId}`}))`.execute(trx);
    if (await trx.selectFrom("digifab_cell_jobs").select("id").where("cell_id", "=", machineId).where("status", "<>", "ended").executeTakeFirst()) throw new ArmRefusal("This cell already has a job open. Stop it before starting another.");
    return trx.insertInto("digifab_cell_jobs").values({ cell_id: machineId, label: plan.job.label, definition: JSON.stringify(plan.job), definition_hash: plan.hash, outcome: null, paused_on: null, paused_reason: null, last_cycle_ms: null, station_id: permit.stationId ?? null, started_by: actor.userId, ended_at: null }).returningAll().executeTakeFirstOrThrow();
  });
  let next: { status: "running" | "uncertain" | "ended"; outcome?: "not-started"; ended_at?: Date; detail?: string }, detail = "";
  try {
    const result = await (await cellDriver(db, orgId, cell.connection_id)).command({ operation: "start", job_id: job.id, job: plan.job });
    detail = result.detail ?? "";
    next = result.ok ? { status: "running" } : { status: "ended", outcome: "not-started", ended_at: new Date(), detail };
  } catch {
    detail = UNANSWERED;
    next = { status: "uncertain", detail };
  }
  const saved = await db.updateTable("digifab_cell_jobs").set(next).where("id", "=", job.id).where("status", "=", "starting").returningAll().executeTakeFirstOrThrow();
  await record(db, orgId, machineId, "start", job.id, actor, saved.status !== "ended", detail);
  if (saved.status === "ended") throw new ArmRefusal(detail || "The cell did not start.");
  return saved;
}

async function openJob(db: Kysely<DigifabDB>, cellId: string) {
  return db.selectFrom("digifab_cell_jobs").selectAll().where("cell_id", "=", cellId).where("status", "<>", "ended").executeTakeFirst();
}

/** Resume a job that paused on a timeout, from the cell's station. */
export async function resumeCellJob(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, actor: CellActor) {
  const { station_token } = z.object({ station_token: Token }).parse(value);
  const cell = await connected(db, machineId);
  await authorizeArm(db, cell.connection_id, cell.device_id, station_token);
  const refused = operatorRefusal(cell, actor);
  if (refused) throw new ArmRefusal(refused);
  const job = await openJob(db, machineId);
  if (!job || job.status !== "paused") throw new ArmRefusal("Only a paused cell job resumes.");
  if (job.paused_on === "fault") throw new ArmRefusal("The job paused on a fault. Clear it at the machines, stop this job and start again.");
  let ok = false, detail = "";
  try { const r = await (await cellDriver(db, orgId, cell.connection_id)).command({ operation: "resume" }); ok = r.ok; detail = r.detail ?? ""; }
  catch { detail = UNANSWERED; }
  await record(db, orgId, machineId, "resume", job.id, actor, ok, detail);
  if (!ok) throw new ArmRefusal(detail || "The cell did not resume.");
  return { ok: true };
}

/** Stop the cell's job and every machine in it, from anywhere. */
export async function stopCellJob(db: Kysely<DigifabDB>, orgId: string, machineId: string, actor: CellActor) {
  const cell = await connected(db, machineId);
  const job = await openJob(db, machineId);
  let ok = false, detail = "";
  try { const r = await (await cellDriver(db, orgId, cell.connection_id)).command({ operation: "stop" }); ok = r.ok; detail = r.detail ?? ""; }
  catch { detail = UNANSWERED; }
  await record(db, orgId, machineId, "stop", job?.id ?? null, actor, ok, detail);
  if (!ok) throw new ArmRefusal(detail || UNANSWERED);
  return { ok: true, detail: detail || undefined };
}

const EndSchema = z.object({ outcome: z.enum(["unknown", "aborted"]), note: z.string().trim().max(1000).default("") });
/** A person closes a job the bridge no longer knows (a restart, a lost
 *  start), saying what they found at the cell. */
export async function endCellJobByPerson(db: Kysely<DigifabDB>, orgId: string, jobId: string, value: unknown, userId: string | null) {
  const input = EndSchema.parse(value);
  const job = await db.selectFrom("digifab_cell_jobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!job || job.status === "ended") throw new ArmRefusal("Choose an open cell job.");
  const cell = await connected(db, job.cell_id);
  let state: CellState | null = null;
  try { state = await (await cellDriver(db, orgId, cell.connection_id)).state(); } catch { state = null; }
  if (state?.job_id === job.id && (state.status === "running" || state.status === "paused")) throw new ArmRefusal("The cell is still running this job. Stop it instead.");
  const saved = await db.updateTable("digifab_cell_jobs").set({ status: "ended", outcome: input.outcome, ended_at: new Date(), detail: input.note }).where("id", "=", jobId).where("status", "<>", "ended").returningAll().executeTakeFirst();
  if (!saved) throw new ArmRefusal("This job already ended.");
  await platform().activity.log({ orgId, userId, action: "cell_job_ended", ref: machineRef(job.cell_id), diff: { job: jobId, outcome: input.outcome, note: input.note } });
  return saved;
}

interface Notice { job: Job; reason: string; on: "timeout" | "fault" }
interface Cycle { job: Job; cycle: number; parts: number }

/** Record the events a cell reported after its cursor. Each id is recorded
 *  once; a replay changes nothing and nothing here commands a machine.
 *  Returns the pauses and cycles that were new, for telling people and
 *  counting stock once. */
export async function ingestCellEvents(db: Kysely<DigifabDB>, cellId: string, page: CellEventPage): Promise<{ fresh: number; paused: Notice[]; cycles: Cycle[] }> {
  let fresh = 0;
  const paused: Notice[] = [], cycles: Cycle[] = [];
  for (const ev of [...page.events].sort((a, b) => a.seq - b.seq)) {
    await db.transaction().execute(async (trx) => {
      const job = await trx.selectFrom("digifab_cell_jobs").selectAll().where("id", "=", ev.job_id).where("cell_id", "=", cellId).forUpdate().executeTakeFirst();
      const inserted = await trx.insertInto("digifab_cell_events").values({ cell_id: cellId, event_id: ev.id, seq: ev.seq, type: ev.type, payload: JSON.stringify(ev), job_id: job?.id ?? null }).onConflict((oc) => oc.columns(["cell_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
      if (!inserted) return;
      fresh++;
      if (!job || job.status === "ended") return;
      const at = new Date(ev.at);
      if (ev.type === "job-started" && (job.status === "starting" || job.status === "uncertain")) await trx.updateTable("digifab_cell_jobs").set({ status: "running" }).where("id", "=", job.id).execute();
      if (ev.type === "step-started") await trx.insertInto("digifab_cell_steps").values({ job_id: job.id, cycle: ev.cycle, step: ev.step, kind: ev.kind, role: ev.role, outcome: null, detail: null, duration_ms: null, started_at: at, ended_at: null }).onConflict((oc) => oc.columns(["job_id", "cycle", "step"]).doNothing()).execute();
      if (ev.type === "step-ended") await trx.updateTable("digifab_cell_steps").set({ outcome: ev.outcome, detail: ev.detail, duration_ms: ev.duration_ms, ended_at: at }).where("job_id", "=", job.id).where("cycle", "=", ev.cycle).where("step", "=", ev.step).execute();
      // A cycle counts once, by its number: a bridge that reports cycle 3
      // again (a restart, a new epoch of ids) adds no parts.
      if (ev.type === "cycle-completed" && ev.cycle > job.cycles) {
        await trx.updateTable("digifab_cell_jobs").set({ cycles: ev.cycle, parts: sql`parts + ${ev.parts}`, last_cycle_ms: ev.cycle_time_ms }).where("id", "=", job.id).execute();
        cycles.push({ job, cycle: ev.cycle, parts: ev.parts });
      }
      if (ev.type === "job-paused") {
        await trx.updateTable("digifab_cell_jobs").set({ status: "paused", paused_on: ev.on, paused_reason: ev.reason }).where("id", "=", job.id).execute();
        paused.push({ job, reason: ev.reason, on: ev.on });
      }
      if (ev.type === "job-resumed") await trx.updateTable("digifab_cell_jobs").set({ status: "running", paused_on: null, paused_reason: null }).where("id", "=", job.id).execute();
      if (ev.type === "job-ended") await trx.updateTable("digifab_cell_jobs").set({ status: "ended", outcome: ev.outcome, ended_at: at, detail: ev.detail ?? "", paused_on: null, paused_reason: null }).where("id", "=", job.id).execute();
    });
  }
  await db.updateTable("digifab_cells").set({ event_cursor: page.cursor }).where("machine_id", "=", cellId).execute();
  return { fresh, paused, cycles };
}

/** Who hears that a cell paused: its operators, or whoever started the job. */
async function tellPaused(orgId: string, cell: Cell, notices: Notice[]) {
  if (!notices.length) return;
  const title = (await platform().entities.lookup(orgId, "machines:machine", cell.machine_id))?.title ?? "A cell";
  const to = new Set<string>(cell.operators);
  for (const n of notices) if (n.job.started_by) to.add(n.job.started_by);
  if (!to.size) for (const id of await platform().notifications.orgMemberIds(orgId).catch(() => [] as string[])) to.add(id);
  const lines = notices.map((n) => `${n.reason}${n.on === "timeout" ? " It can be resumed at the cell." : " Clear it at the machines, then stop the job."}`);
  const message = `${title} paused: ${lines.join(" ")}`.slice(0, 500);
  await Promise.all([...to].map((userId) =>
    // dispatch-per-row-ok: one message per person told, holding every pause this pass found for this cell
    platform().notifications.dispatch({ orgId, userId, eventType: "digifab.cell.paused", message, link_url: `/station/cell/${cell.machine_id}`, module: "digifab", entityType: "machines:machine", entityId: cell.machine_id, card: { heading: `${title} paused`, body: lines.join("\n") } }).catch(() => {}),
  ));
}

/** A cell's parts go to its output part, once per job and cycle. Each job
 *  keeps how many of its cycles are in stock, so a pass that could not add
 *  them is caught up by the next, and an add is never made twice. */
async function countParts(db: Kysely<DigifabDB>, orgId: string, cell: Cell) {
  const jobs = await db.selectFrom("digifab_cell_jobs").selectAll().where("cell_id", "=", cell.machine_id).whereRef("cycles", ">", "stock_cycles").orderBy("started_at").limit(5).execute();
  for (const job of jobs) {
    const perCycle = Number((job.definition as { parts_per_cycle?: unknown }).parts_per_cycle ?? 0);
    if (!cell.output_part_id || perCycle <= 0) { await db.updateTable("digifab_cell_jobs").set({ stock_cycles: job.cycles }).where("id", "=", job.id).execute(); continue; }
    for (let n = job.stock_cycles + 1; n <= job.cycles; n++) {
      const added = await platform().actions.invoke("inventory:adjust-stock", { orgId, userId: job.started_by, entity: { kind: "inventory:part", id: cell.output_part_id }, args: { partId: cell.output_part_id, delta: perCycle, once: true, reason: `Cell job ${job.label || job.id.slice(0, 8)}, cycle ${n}`, sourceKind: "digifab:cell-job", sourceId: `${job.id}:${n}` }, event: { name: "digifab.cell.cycle", payload: { jobId: job.id, cycle: n }, actor: { user_id: job.started_by, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" } });
      if (!actionActed(added)) throw new Error(`The cell's parts for cycle ${n} were not added to stock; the next pass tries again.`);
      await db.updateTable("digifab_cell_jobs").set({ stock_cycles: n }).where("id", "=", job.id).where("stock_cycles", "=", n - 1).execute();
    }
  }
}

/** One look at a cell: its events, then its state, which settles a start
 *  whose answer was lost and says when the bridge no longer knows the job. */
export async function watchCell(db: Kysely<DigifabDB>, orgId: string, machineId: string) {
  const cell = await connected(db, machineId);
  const driver = await cellDriver(db, orgId, cell.connection_id);
  const got = await ingestCellEvents(db, machineId, await driver.events(Number(cell.event_cursor)));
  await tellPaused(orgId, cell, got.paused);
  for (const c of got.cycles) void platform().events.emit("digifab.cell.cycle", { orgId, cellId: cell.machine_id, jobId: c.job.id, cycle: c.cycle, parts: c.parts, outputPartId: cell.output_part_id });
  try { await countParts(db, orgId, cell); }
  catch (err) { platform().health.notePassFailure("digifab.cell-monitor", `${orgId}:${machineId}:stock`, err); }
  const state = await driver.state();
  const job = await openJob(db, machineId);
  if (!job || state.job_id === job.id) return { state };
  // A start still on its way is not a lost one.
  if (job.status === "starting" && Date.now() - new Date(job.started_at).getTime() < 120_000) return { state };
  // The bridge has no record of this job: a start it never received, or a
  // bridge that restarted. Nothing is resent; the job's outcome is said.
  const why = job.status === "uncertain" || job.status === "starting" ? { outcome: "not-started" as const, detail: "The bridge has no record of this start." } : { outcome: "unknown" as const, detail: "The bridge restarted or lost the job. Check the cell." };
  await db.updateTable("digifab_cell_jobs").set({ status: "ended", outcome: why.outcome, detail: why.detail, ended_at: new Date() }).where("id", "=", job.id).where("status", "<>", "ended").execute();
  return { state };
}

export function registerCellMonitor(): void {
  platform().sweeps.register({ name: "digifab.cell-monitor", module: "digifab", everyMs: 5_000, firstAfterMs: 10_000,
    visit: async ({ orgId, db }) => {
      // A workspace with robot arms off has its cells hidden, not watched.
      if (!(await platform().parts.isOn(orgId, "digifab", "arms"))) return;
      const tenant = db as Kysely<DigifabDB>;
      const cells = await tenant.selectFrom("digifab_cells").select("machine_id").where("connection_id", "is not", null).execute();
      await Promise.all(cells.map(async (c) => {
        try { await watchCell(tenant, orgId, c.machine_id); }
        catch (err) { platform().health.notePassFailure("digifab.cell-monitor", `${orgId}:${c.machine_id}`, err); }
      }));
    },
  });
}

/** A machine in an open cell job takes no other work from Cobblr. */
export async function cellHoldRefusal(db: Kysely<DigifabDB>, connectionId: string, deviceId: string | null): Promise<string | null> {
  let q = db.selectFrom("digifab_cell_members as m").innerJoin("digifab_cell_jobs as j", "j.cell_id", "m.cell_id").select(["m.cell_id", "m.role"]).where("m.connection_id", "=", connectionId).where("j.status", "<>", "ended");
  if (deviceId) q = q.where("m.device_id", "=", deviceId);
  const held = await q.executeTakeFirst();
  return held ? `This machine is ${held.role} in a cell's job. Stop that job first; pause and stop still reach it.` : null;
}
