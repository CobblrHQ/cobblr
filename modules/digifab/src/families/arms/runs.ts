import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { ARM_RUN_KINDS, type ArmEvent, type ArmEventPage, type ArmState } from "@cobblr/platform-contract/robot-arm";
import { raiseAlarm } from "../../core/alarms.js";
import type { DigifabDB } from "../../db.js";
import { authorizeArm, ArmRefusal } from "./station.js";
import { armDriver, machineRef, requireUnit } from "./store.js";
import { sendArmCommand, type ArmActor } from "./control.js";
import { APPROVAL_MINUTES, OWNERSHIP_MINUTES, approvalRefusal, eventEffect, linkLost, personOutcomeRefusal, reconcileStart, strandedStart, takeControlRefusal, type OpenRun } from "./rules.js";
type Run = Selectable<DigifabDB["digifab_arm_runs"]>;
const Token = z.string().min(32).max(128);
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
async function liveState(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string): Promise<ArmState | null> {
 try { return await (await armDriver(db, orgId, connectionId)).state(deviceId); } catch { return null; }
}
async function connected(db: Kysely<DigifabDB>, machineId: string) {
 const unit = await requireUnit(db, machineId);
 if (!unit.connection_id || !unit.device_id) throw new ArmRefusal("This arm has no controller connection. Run it at its pendant.");
 return unit as typeof unit & { connection_id: string; device_id: string };
}

export async function takeControl(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, userId: string) {
 const { station_token } = z.object({ station_token: Token }).parse(value);
 const unit = await connected(db, machineId);
 const permit = await authorizeArm(db, unit.connection_id, unit.device_id, station_token);
 const own = await db.selectFrom("digifab_arm_ownership").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
 const refused = takeControlRefusal(own ?? null, permit.stationId!, await liveState(db, orgId, unit.connection_id, unit.device_id), new Date());
 if (refused) throw new ArmRefusal(refused);
 const values = { station_id: permit.stationId!, user_id: userId, acquired_at: new Date(), expires_at: minutes(OWNERSHIP_MINUTES), released_at: null, release_reason: null };
 await db.insertInto("digifab_arm_ownership").values({ machine_id: machineId, ...values }).onConflict(oc => oc.column("machine_id").doUpdateSet(values)).execute();
 return { ok: true, expires_at: values.expires_at };
}
/** Release control: the holding station, an admin, the pendant, or expiry. */
export async function releaseControl(db: Kysely<DigifabDB>, orgId: string, machineId: string, reason: "released" | "revoked" | "pendant", userId: string | null) {
 const row = await db.updateTable("digifab_arm_ownership").set({ released_at: new Date(), release_reason: reason }).where("machine_id", "=", machineId).where("released_at", "is", null).returning("station_id").executeTakeFirst();
 if (row && reason === "revoked") await platform().activity.log({ orgId, userId, action: "arm_control_revoked", ref: machineRef(machineId), diff: { station_id: row.station_id } });
 return { ok: true, released: !!row };
}
export async function releaseOwnControl(db: Kysely<DigifabDB>, _orgId: string, machineId: string, value: unknown) {
 const { station_token } = z.object({ station_token: Token }).parse(value);
 const unit = await connected(db, machineId);
 const permit = await authorizeArm(db, unit.connection_id, unit.device_id, station_token);
 await db.updateTable("digifab_arm_ownership").set({ released_at: new Date(), release_reason: "released" }).where("machine_id", "=", machineId).where("station_id", "=", permit.stationId!).where("released_at", "is", null).execute();
 return { ok: true };
}

export const ApproveSchema = z.object({ station_token: Token, program_id: z.string().uuid(), tooling: z.string().trim().max(500), cell_clear: z.literal(true) });
/** A person at the cell approves one program revision with the tooling that
 *  is installed. The station screen alone is not this authority: it takes a
 *  signed-in operator, owner or admin at that screen. */
export async function approveRun(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, userId: string) {
 const input = ApproveSchema.parse(value);
 const unit = await connected(db, machineId);
 const permit = await authorizeArm(db, unit.connection_id, unit.device_id, input.station_token);
 const program = await db.selectFrom("digifab_arm_programs").selectAll().where("id", "=", input.program_id).where("machine_id", "=", machineId).executeTakeFirst();
 if (!program || program.missing_since) throw new ArmRefusal("Choose a program this arm's controller holds.");
 if (!program.released_at) throw new ArmRefusal("This revision is not released for production. Review what changed in it and release it first.");
 if (input.tooling !== unit.tooling) throw new ArmRefusal("The tooling you checked is not the tooling recorded on this arm. Record what is installed, then approve.");
 const row = await db.insertInto("digifab_arm_approvals").values({ machine_id: machineId, program_id: program.id, revision: program.revision, tooling: unit.tooling, station_id: permit.stationId!, approved_by: userId, expires_at: minutes(APPROVAL_MINUTES), used_at: null, revoked_at: null }).returningAll().executeTakeFirstOrThrow();
 await platform().activity.log({ orgId, userId, action: "arm_run_approved", ref: machineRef(machineId), diff: { program: program.name, revision: program.revision, tooling: unit.tooling } });
 return row;
}

export const StartRunSchema = z.object({
 station_token: Token, approval_id: z.string().uuid(), kind: z.enum(ARM_RUN_KINDS),
 label: z.string().trim().max(200).default(""), ref: z.string().trim().max(200).default(""), target_cycles: z.number().int().positive().max(1_000_000).nullable().default(null),
});
/** Start one run: its approval is used once, Start is sent once, and a lost
 *  answer leaves the run uncertain until a reading says what happened. */
export async function startRun(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, actor: ArmActor & { userId: string }) {
 const input = StartRunSchema.parse(value);
 const unit = await connected(db, machineId);
 await authorizeArm(db, unit.connection_id, unit.device_id, input.station_token);
 const approval = await db.selectFrom("digifab_arm_approvals").selectAll().where("id", "=", input.approval_id).where("machine_id", "=", machineId).executeTakeFirst();
 if (!approval) throw new ArmRefusal("Approve this run at the cell first.");
 const program = await db.selectFrom("digifab_arm_programs").selectAll().where("id", "=", approval.program_id).executeTakeFirst();
 const refused = approvalRefusal(approval, program ?? null, unit.tooling, new Date());
 if (refused || !program) throw new ArmRefusal(refused ?? "Approve this run at the cell first.");
 const run = await db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext(${`digifab-arm-run:${machineId}`}))`.execute(trx);
  const used = await trx.updateTable("digifab_arm_approvals").set({ used_at: new Date() }).where("id", "=", approval.id).where("used_at", "is", null).where("revoked_at", "is", null).returning("id").executeTakeFirst();
  if (!used) throw new ArmRefusal("This approval already started a run. A new run needs a new approval at the cell.");
  const open = await trx.selectFrom("digifab_arm_runs").select("id").where("machine_id", "=", machineId).where("status", "<>", "ended").executeTakeFirst();
  if (open) throw new ArmRefusal("This arm already has a run open. End it before starting another.");
  return trx.insertInto("digifab_arm_runs").values({ machine_id: machineId, kind: input.kind, label: input.label, ref: input.ref, target_cycles: input.target_cycles, program_id: program.id, approval_id: approval.id, outcome: null, controller_run_id: null, link_lost: null, started_by: actor.userId, ended_at: null }).returningAll().executeTakeFirstOrThrow();
 });
 // A refusal is thrown before anything is sent; any other failure may come
 // after, so it is read like a lost answer, then thrown on. Either way the
 // run leaves "starting".
 let failed: unknown = null;
 const sent = await sendArmCommand(db, orgId, machineId, { command: { operation: "start", program: { name: program.name, revision: program.revision } }, station_token: input.station_token }, actor, { run: { id: run.id } })
  .catch((e: unknown): Awaited<ReturnType<typeof sendArmCommand>> => { if (e instanceof ArmRefusal) return { ok: false, detail: e.message, state: null }; failed = e; return { ok: false, detail: "", state: null, unanswered: true }; });
 const next = sent.unanswered
  ? { status: "uncertain" as const, evidence: JSON.stringify({ start: "unanswered" }) }
  : sent.ok ? { status: "running" as const, controller_run_id: sent.run_id ?? null, evidence: JSON.stringify({ start: "acknowledged" }) }
  : { status: "ended" as const, outcome: "not-started" as const, ended_at: new Date(), evidence: JSON.stringify({ start: "refused", detail: sent.detail ?? "" }) };
 // The monitor may have read the arm's own events while Start was in flight
 // and moved the run on; what the arm reported stands over the answer.
 const saved = await db.updateTable("digifab_arm_runs").set(next).where("id", "=", run.id).where("status", "=", "starting").returningAll().executeTakeFirst()
  ?? await db.selectFrom("digifab_arm_runs").selectAll().where("id", "=", run.id).executeTakeFirstOrThrow();
 await platform().activity.log({ orgId, userId: actor.userId, action: "arm_run_started", ref: machineRef(machineId), diff: { run: run.id, kind: input.kind, program: program.name, revision: program.revision, status: saved.status } });
 if (failed) throw failed;
 if (saved.status === "ended" && saved.outcome === "not-started") throw new ArmRefusal(sent.detail || "The arm did not start.");
 return saved;
}

const EndSchema = z.object({ outcome: z.enum(["unknown", "aborted"]), note: z.string().trim().max(1000).default("") });
export async function endRunByPerson(db: Kysely<DigifabDB>, orgId: string, runId: string, value: unknown, userId: string | null) {
 const input = EndSchema.parse(value);
 const run = await db.selectFrom("digifab_arm_runs").selectAll().where("id", "=", runId).executeTakeFirst();
 if (!run || run.status === "ended") throw new ArmRefusal("Choose an open run.");
 const unit = await connected(db, run.machine_id);
 const refused = personOutcomeRefusal(input.outcome, await liveState(db, orgId, unit.connection_id, unit.device_id));
 if (refused) throw new ArmRefusal(refused);
 const saved = await db.updateTable("digifab_arm_runs").set({ status: "ended", outcome: input.outcome, ended_at: new Date(), evidence: JSON.stringify({ ...run.evidence, ended_by: userId, note: input.note }) }).where("id", "=", runId).where("status", "<>", "ended").returningAll().executeTakeFirst();
 if (!saved) throw new ArmRefusal("This run already ended.");
 await platform().activity.log({ orgId, userId, action: "arm_run_ended", ref: machineRef(run.machine_id), diff: { run: runId, outcome: input.outcome, note: input.note } });
 return saved;
}

const openRunOf = (run: Run | undefined, program: { name: string; revision: string | null } | null): OpenRun | null =>
 run && run.status !== "ended" ? { status: run.status, program, controller_run_id: run.controller_run_id } : null;

/** Record the events an arm reported after the unit's cursor. Each event id
 *  is recorded once; a replay or an overlap changes nothing; nothing here
 *  ever sends the arm a command. Returns how many were new. */
export async function ingestArmEvents(db: Kysely<DigifabDB>, orgId: string, machineId: string, page: ArmEventPage): Promise<number> {
 let fresh = 0, cycles = 0;
 const alarms: Array<Extract<ArmEvent, { type: "alarm" }>> = [];
 for (const ev of [...page.events].sort((a, b) => a.seq - b.seq)) {
  await db.transaction().execute(async trx => {
   const run = await trx.selectFrom("digifab_arm_runs").selectAll().where("machine_id", "=", machineId).where("status", "<>", "ended").forUpdate().executeTakeFirst();
   const inserted = await trx.insertInto("digifab_arm_events").values({ machine_id: machineId, event_id: ev.id, seq: ev.seq, type: ev.type, payload: JSON.stringify(ev), run_id: run?.id ?? null }).onConflict(oc => oc.columns(["machine_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
   if (!inserted) return;
   fresh++;
   // Every cycle wears the arm and its tools, whoever started the program.
   if (ev.type === "cycle-completed") cycles++;
   if (ev.type === "alarm") alarms.push(ev);
   const program = run?.program_id ? await trx.selectFrom("digifab_arm_programs").select(["name", "revision"]).where("id", "=", run.program_id).executeTakeFirst() : undefined;
   const effect = eventEffect(ev, openRunOf(run, program ?? null));
   if (effect.kind === "release-control") await trx.updateTable("digifab_arm_ownership").set({ released_at: new Date(), release_reason: "pendant" }).where("machine_id", "=", machineId).where("released_at", "is", null).execute();
   if (!run) return;
   if (effect.kind === "adopt") await trx.updateTable("digifab_arm_runs").set({ controller_run_id: effect.controller_run_id, status: "running" }).where("id", "=", run.id).execute();
   if (effect.kind === "cycle") await trx.updateTable("digifab_arm_runs").set({ cycles: sql`greatest(cycles, ${effect.cycle})`, good: sql`good + ${effect.good}`, scrap: sql`scrap + ${effect.scrap}` }).where("id", "=", run.id).execute();
   if (effect.kind === "end") await trx.updateTable("digifab_arm_runs").set({ status: "ended", outcome: effect.outcome, ended_at: new Date(ev.at), evidence: JSON.stringify({ ...run.evidence, ended_by_event: ev.id, detail: effect.detail }) }).where("id", "=", run.id).execute();
  });
 }
 // The bridge's cursor, not the larger one: a restarted bridge numbers from
 // the start again, and a cursor kept above it would never read its events.
 // Reading one twice is harmless, every event id is recorded once.
 await db.updateTable("digifab_arm_units").set({ event_cursor: page.cursor }).where("machine_id", "=", machineId).execute();
 if (cycles) await platform().actions.invoke("machines:record-usage", { orgId, userId: null, entity: { kind: "machines:machine", id: machineId }, args: { machineId, cycles }, event: { name: "digifab.arm.cycles", payload: { machineId, cycles }, actor: { user_id: null, display_name: null, auth_method: "session" }, timestamp: new Date().toISOString(), trigger_type: "event" } })
  .catch((err) => platform().health.notePassFailure("digifab.arm-monitor", `${orgId}:${machineId}:usage`, err));
 const unit = alarms.length ? await db.selectFrom("digifab_arm_units").select(["connection_id", "device_id"]).where("machine_id", "=", machineId).executeTakeFirst() : undefined;
 const device = unit?.connection_id && unit.device_id ? { connection_id: unit.connection_id, device_id: unit.device_id } : null;
 for (const a of alarms) await raiseAlarm(db, orgId, { device, machine_id: machineId, source: "arm", code: a.code, text: a.text, severity: a.severity, program: a.program ? `${a.program.name}${a.program.revision ? ` (${a.program.revision})` : ""}` : null, step: a.step, occurred_at: new Date(a.at), source_ref: a.id });
 return fresh;
}

/** One look at an arm: its events first, then its state, which settles an
 *  uncertain start, gives way to the pendant and says which link is lost. */
export async function watchArm(db: Kysely<DigifabDB>, orgId: string, machineId: string) {
 const unit = await connected(db, machineId);
 const driver = await armDriver(db, orgId, unit.connection_id);
 let answered = true, state: ArmState | null = null;
 try {
  await ingestArmEvents(db, orgId, machineId, await driver.events(unit.device_id, Number(unit.event_cursor)));
  state = await driver.state(unit.device_id);
 } catch { answered = false; } // pass-catch: an unreachable bridge is a reading, recorded on the run as link_lost "cloud", not a failure of the pass
 const lost = linkLost(answered, state);
 if (state?.mode === "local") await releaseControl(db, orgId, machineId, "pendant", null);
 const run = await db.selectFrom("digifab_arm_runs").selectAll().where("machine_id", "=", machineId).where("status", "<>", "ended").executeTakeFirst();
 if (!run) return { state, link_lost: lost };
 await db.updateTable("digifab_arm_runs").set({ link_lost: lost }).where("id", "=", run.id).execute();
 const program = run.program_id ? await db.selectFrom("digifab_arm_programs").select(["name", "revision"]).where("id", "=", run.program_id).executeTakeFirst() : undefined;
 if (strandedStart(run, new Date())) {
  await db.updateTable("digifab_arm_runs").set({ status: "uncertain", evidence: JSON.stringify({ ...run.evidence, start: "stranded" }) }).where("id", "=", run.id).where("status", "=", "starting").execute();
  run.status = "uncertain";
 }
 const settled = reconcileStart({ status: run.status as OpenRun["status"], program: program ?? null, controller_run_id: run.controller_run_id }, state);
 if (settled?.status === "running") await db.updateTable("digifab_arm_runs").set({ status: "running", controller_run_id: settled.controller_run_id, evidence: JSON.stringify({ ...run.evidence, reconciled: state }) }).where("id", "=", run.id).where("status", "=", "uncertain").execute();
 if (settled?.status === "ended") await db.updateTable("digifab_arm_runs").set({ status: "ended", outcome: settled.outcome, ended_at: new Date(), evidence: JSON.stringify({ ...run.evidence, reconciled: state, why: settled.why }) }).where("id", "=", run.id).where("status", "=", "uncertain").execute();
 return { state, link_lost: lost };
}

export function registerArmMonitor(): void {
 platform().sweeps.register({ name: "digifab.arm-monitor", module: "digifab", everyMs: 10_000, firstAfterMs: 10_000,
  visit: async ({ orgId, db }) => {
   // A workspace with robot arms off has its arms hidden, not watched.
   if (!(await platform().parts.isOn(orgId, "digifab", "arms"))) return;
   const tenant = db as Kysely<DigifabDB>;
   const units = await tenant.selectFrom("digifab_arm_units").select("machine_id").where("connection_id", "is not", null).execute();
   await Promise.all(units.map(async u => {
    try { await watchArm(tenant, orgId, u.machine_id); }
    catch (err) { platform().health.notePassFailure("digifab.arm-monitor", `${orgId}:${u.machine_id}`, err); }
   }));
  },
 });
}
