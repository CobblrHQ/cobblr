import "./db.js";
import { sql, type Kysely, type Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { ArmInfo, ArmState } from "@cobblr/platform-contract/robot-arm";
import type { DigifabDB } from "../../db.js";
import { buildDriverById } from "../../jobs-core.js";
import { EdgeAdapterDriver } from "../../drivers/edge-adapter.js";
import { ArmRefusal } from "./station.js";
import { EdgeArm } from "./edge-arm.js";
import { CompatibilitySchema, MaintenanceSchema, ProgramEditSchema, SetupSchema, TypedProgramSchema, supportOf } from "./model.js";
type Unit = Selectable<DigifabDB["digifab_arm_units"]>;
type Program = Selectable<DigifabDB["digifab_arm_programs"]>;
export async function armDriver(db: Kysely<DigifabDB>, orgId: string, connectionId: string): Promise<EdgeArm> {
 const driver = await buildDriverById(db, orgId, connectionId);
 if (!(driver instanceof EdgeAdapterDriver)) throw new ArmRefusal("A robot arm connects through your shop's bridge.");
 return new EdgeArm(driver);
}
export async function requireUnit(db: Kysely<DigifabDB>, machineId: string): Promise<Unit> {
 const unit = await db.selectFrom("digifab_arm_units").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
 if (!unit) throw new ArmRefusal("Set this machine up as a robot arm first.");
 return unit;
}
async function requireMachine(orgId: string, machineId: string) {
 const machine = await platform().entities.lookup(orgId, MACHINE, machineId);
 if (!machine || machine.retired) throw new ArmRefusal("Choose an existing machine for this arm.");
 return machine;
}
/** Arm events land in the machine's own history. */
const MACHINE = "machines:machine";
const [machineModule, machineType] = MACHINE.split(":") as [string, string];
export const machineRef = (machineId: string) => ({ module: machineModule, entityType: machineType, entityId: machineId });
export async function setupArm(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
 const setup = SetupSchema.parse(value);
 await requireMachine(orgId, machineId);
 if (setup.connection_id && setup.device_id) {
  const driver = await armDriver(db, orgId, setup.connection_id);
  try { await driver.state(setup.device_id); } catch { throw new ArmRefusal("Choose an arm your bridge reports. It did not answer with an arm's state."); }
 }
 await db.insertInto("digifab_arm_units").values({ machine_id: machineId, connection_id: setup.connection_id, device_id: setup.device_id }).onConflict(oc => oc.column("machine_id").doUpdateSet({ connection_id: setup.connection_id, device_id: setup.device_id, updated_at: new Date() })).execute();
 await platform().activity.log({ orgId, userId, action: "arm_set_up", ref: machineRef(machineId), diff: { connection_id: setup.connection_id, device_id: setup.device_id } });
 if (setup.connection_id) await refreshArm(db, orgId, userId, machineId);
 return { ok: true };
}
const versionsOf = (info: ArmInfo | null) => JSON.stringify((info?.software_versions ?? []).map(v => `${v.name}=${v.version}`).sort());
/** Read the controller's info and its program list into the records. A
 *  program the controller no longer lists is kept and marked missing, never
 *  deleted: its commands still name it. */
export async function refreshArm(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string) {
 const unit = await requireUnit(db, machineId);
 if (!unit.connection_id || !unit.device_id) throw new ArmRefusal("This arm has no controller connection. Type its programs instead.");
 const driver = await armDriver(db, orgId, unit.connection_id);
 const [info, list] = await Promise.all([driver.info(unit.device_id), driver.programs(unit.device_id)]);
 if (versionsOf(unit.last_info) !== versionsOf(info)) await platform().activity.log({ orgId, userId, action: "arm_versions_reported", ref: machineRef(machineId), diff: { model: info.model, software_versions: info.software_versions, previous: unit.last_info?.software_versions ?? null } });
 await db.updateTable("digifab_arm_units").set({ last_info: JSON.stringify(info), info_seen_at: new Date(), updated_at: new Date() }).where("machine_id", "=", machineId).execute();
 if (!list.supported) return { info, programs_listed: false, detail: list.detail };
 const now = new Date();
 await db.transaction().execute(async trx => {
  await sql`select pg_advisory_xact_lock(hashtext(${`digifab-arm-programs:${machineId}`}))`.execute(trx);
  for (const p of list.programs) {
   const existing = await trx.selectFrom("digifab_arm_programs").select("id").where("machine_id", "=", machineId).where("name", "=", p.name).where(eb => p.revision === null ? eb("revision", "is", null) : eb("revision", "=", p.revision)).executeTakeFirst();
   if (existing) await trx.updateTable("digifab_arm_programs").set({ last_seen_at: now, missing_since: null }).where("id", "=", existing.id).execute();
   else await trx.insertInto("digifab_arm_programs").values({ machine_id: machineId, name: p.name, revision: p.revision, family: null, source: "controller" }).execute();
  }
  await trx.updateTable("digifab_arm_programs").set({ missing_since: now }).where("machine_id", "=", machineId).where("source", "=", "controller").where("last_seen_at", "<", now).where("missing_since", "is", null).execute();
 });
 return { info, programs_listed: true, count: list.programs.length };
}
export async function addTypedProgram(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
 const p = TypedProgramSchema.parse(value);
 await requireUnit(db, machineId);
 const row = await db.insertInto("digifab_arm_programs").values({ machine_id: machineId, name: p.name, revision: p.revision, family: p.family, tool: p.tool, installation: p.installation, source: "typed" }).onConflict(oc => oc.doNothing()).returningAll().executeTakeFirst();
 if (!row) throw new ArmRefusal("This arm already has that program at that revision.");
 await platform().activity.log({ orgId, userId, action: "arm_program_added", ref: machineRef(machineId), diff: { name: p.name, revision: p.revision, family: p.family } });
 return row;
}
export async function editProgram(db: Kysely<DigifabDB>, orgId: string, userId: string | null, programId: string, value: unknown) {
 const p = ProgramEditSchema.parse(value);
 const before = await db.selectFrom("digifab_arm_programs").select(["family", "tool", "installation"]).where("id", "=", programId).executeTakeFirst();
 if (!before) throw new ArmRefusal("No such arm program.");
 const change = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
 const row = await db.updateTable("digifab_arm_programs").set(change).where("id", "=", programId).returningAll().executeTakeFirst();
 if (!row) throw new ArmRefusal("No such arm program.");
 await platform().activity.log({ orgId, userId, action: "arm_program_updated", ref: machineRef(row.machine_id), diff: { name: row.name, revision: row.revision, ...change, before: Object.fromEntries(Object.keys(change).map(k => [k, before[k as keyof typeof before]])) } });
 return row;
}
export async function saveCompatibility(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
 const c = CompatibilitySchema.parse(value);
 await requireUnit(db, machineId);
 await db.updateTable("digifab_arm_units").set({ compatibility: JSON.stringify(c), updated_at: new Date() }).where("machine_id", "=", machineId).execute();
 await platform().activity.log({ orgId, userId, action: "arm_compatibility_recorded", ref: machineRef(machineId), diff: { support: supportOf(c) } });
 return { ok: true, support: supportOf(c) };
}
export async function setMaintenance(db: Kysely<DigifabDB>, orgId: string, userId: string | null, machineId: string, value: unknown) {
 const m = MaintenanceSchema.parse(value);
 const unit = await requireUnit(db, machineId);
 if (unit.maintenance === m.maintenance && unit.maintenance_note === m.note) return { ok: true };
 await db.updateTable("digifab_arm_units").set({ maintenance: m.maintenance, maintenance_note: m.note, updated_at: new Date() }).where("machine_id", "=", machineId).execute();
 await platform().activity.log({ orgId, userId, action: "arm_maintenance_changed", ref: machineRef(machineId), diff: { from: unit.maintenance, to: m.maintenance, note: m.note } });
 return { ok: true };
}
/** Programs by family. A family names the job ("unload CNC 3"); each unit's
 *  program in it is still its own record, bound to that arm and revision. */
export function byFamily(programs: Program[]) {
 const groups = new Map<string, Program[]>();
 for (const p of programs) groups.set(p.family ?? "", [...(groups.get(p.family ?? "") ?? []), p]);
 return [...groups].map(([family, items]) => ({ family: family || null, programs: items })).sort((a, b) => (a.family === null ? 1 : b.family === null ? -1 : a.family.localeCompare(b.family)));
}
export async function readArm(db: Kysely<DigifabDB>, orgId: string, machineId: string) {
 const unit = await db.selectFrom("digifab_arm_units").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
 if (!unit) return { unit: null, state: null, connection_error: null, programs: [], families: [], compatibility: null, support: "untested" as const };
 let state: ArmState | null = null, connection_error: string | null = null;
 if (unit.connection_id && unit.device_id) {
  try { state = await (await armDriver(db, orgId, unit.connection_id)).state(unit.device_id); }
  catch { connection_error = "The arm's bridge did not answer. Its state is unknown; check the arm at the cell."; }
 }
 const programs = await db.selectFrom("digifab_arm_programs").selectAll().where("machine_id", "=", machineId).orderBy("name").orderBy("first_seen_at").execute();
 const compatibility = CompatibilitySchema.parse(unit.compatibility ?? {});
 return { unit, state, connection_error, programs, families: byFamily(programs), compatibility, support: supportOf(compatibility) };
}
/** Every unit's program in one family, across arms: the same family is a
 *  different program on two identical arms. */
export async function readFamily(db: Kysely<DigifabDB>, family: string) {
 return db.selectFrom("digifab_arm_programs").selectAll().where("family", "=", family).orderBy("machine_id").orderBy("name").execute();
}
