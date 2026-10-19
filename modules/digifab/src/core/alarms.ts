// Alarm history with escalation, for every machine (core spec #6883 §7). An
// alarm is what a machine raised, in its own code and words, with the program
// and step when known and a camera frame from beside it when there is one.
// It is recorded once per source event, told to the operators at once, then
// to the supervisors and then the integrators until someone acknowledges it.
// An alarm is a record and a reason to tell people; nothing here commands a
// machine.
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { getSnapshot } from "../snapshot-store.js";

type Alarm = Selectable<DigifabDB["digifab_alarms"]>;
export class AlarmRefusal extends Error {}
export interface NewAlarm { device?: { connection_id: string; device_id: string } | null; machine_id: string; source: "arm" | "machine"; source_ref: string; code: string; text: string; severity: "info" | "warning" | "error"; program?: string | null; step?: string | null; occurred_at: Date }
const MACHINE_KIND = "machines:machine";
const [machineModule, machineType] = MACHINE_KIND.split(":") as [string, string];
const machineRef = (id: string) => ({ module: machineModule, entityType: machineType, entityId: id });

/** When the next level is told about an alarm at `level`: the supervisors a
 *  while after it was raised, the integrators a while longer, then no one. */
export function nextEscalationAt(level: number, occurredAt: Date, policy: { supervisor_after_minutes: number; integrator_after_minutes: number }): Date | null {
  if (level === 0) return new Date(occurredAt.getTime() + policy.supervisor_after_minutes * 60_000);
  if (level === 1) return new Date(occurredAt.getTime() + policy.integrator_after_minutes * 60_000);
  return null;
}

export async function escalationOf(db: Kysely<DigifabDB>) {
  const row = await db.selectFrom("digifab_alarm_escalation").selectAll().where("id", "=", 1).executeTakeFirst();
  return row ?? { id: 1, operators: [] as string[], supervisors: [] as string[], integrators: [] as string[], supervisor_after_minutes: 15, integrator_after_minutes: 60, updated_at: new Date(0) };
}

/** The frame a camera beside the machine saw, kept as a file with the alarm. */
async function cameraFrame(db: Kysely<DigifabDB>, orgId: string, machineId: string, device: NewAlarm["device"]): Promise<string | null> {
  const link = device ? { connection_id: device.connection_id, remote_device_id: device.device_id } : await db.selectFrom("digifab_device_links").select(["connection_id", "remote_device_id"]).where("machine_id", "=", machineId).executeTakeFirst();
  if (!link?.connection_id || !link.remote_device_id) return null;
  const jpeg = await getSnapshot(db, link.connection_id, link.remote_device_id).catch(() => null);
  if (!jpeg) return null;
  const file = await platform().files.write(orgId, jpeg, { filename: "alarm-camera.jpg", mimeType: "image/jpeg" }).catch(() => null);
  return file?.fileId ?? null;
}

async function machineName(orgId: string, machineId: string) {
  return (await platform().entities.lookup(orgId, MACHINE_KIND, machineId).catch(() => null))?.title ?? "A machine";
}

/** Tell one level about the alarms it is due, one message per person. */
async function tell(orgId: string, level: number, people: string[], alarms: Alarm[]) {
  if (!people.length || !alarms.length) return;
  const lines = await Promise.all(alarms.map(async (a) => `${await machineName(orgId, a.machine_id)}: ${a.code} ${a.text}`));
  const message = (alarms.length === 1 ? `Alarm on ${lines[0]}` : `${alarms.length} alarms: ${lines.join("; ")}`).slice(0, 500);
  const link = await platform().entities.recordAddressForEntity(orgId, MACHINE_KIND, alarms[0]!.machine_id).catch(() => undefined);
  const heading = level === 0 ? "A machine raised an alarm" : `Not acknowledged after ${level === 1 ? "the operators were told" : "the supervisors were told"}`;
  await Promise.all(people.map((userId) =>
    // dispatch-per-row-ok: one message per person at this level, every alarm due to them in it
    platform().notifications.dispatch({ orgId, userId, eventType: "digifab.alarm", message, ...(link ? { link_url: link } : { no_link_reason: "the machine has no page here" }), module: "digifab", entityType: MACHINE_KIND, entityId: alarms[0]!.machine_id, card: { heading, body: lines.join("\n") } }).catch(() => {}),
  ));
}

/** Record an alarm once (a replayed source event changes nothing), keep the
 *  camera frame, and tell the operators. */
export async function raiseAlarm(db: Kysely<DigifabDB>, orgId: string, a: NewAlarm): Promise<Alarm | null> {
  const policy = await escalationOf(db);
  const next = a.severity === "error" ? nextEscalationAt(0, a.occurred_at, policy) : null;
  const row = await db.insertInto("digifab_alarms").values({ machine_id: a.machine_id, source: a.source, source_ref: a.source_ref.slice(0, 300), code: a.code.slice(0, 100), text: a.text.slice(0, 500), severity: a.severity, program: a.program ?? null, step: a.step ?? null, camera_file_id: null, occurred_at: a.occurred_at, next_escalation_at: next, acknowledged_by: null, acknowledged_at: null })
    .onConflict((oc) => oc.columns(["machine_id", "source_ref"]).doNothing()).returningAll().executeTakeFirst();
  if (!row) return null;
  const camera = await cameraFrame(db, orgId, a.machine_id, a.device);
  if (camera) await db.updateTable("digifab_alarms").set({ camera_file_id: camera }).where("id", "=", row.id).execute();
  await platform().activity.log({ orgId, userId: null, action: "machine_alarm_raised", ref: machineRef(a.machine_id), diff: { code: a.code, text: a.text, severity: a.severity, program: a.program ?? null, step: a.step ?? null } });
  if (a.severity !== "info") await tell(orgId, 0, policy.operators, [row]);
  return { ...row, camera_file_id: camera };
}

const AckSchema = z.object({ alarm_id: z.string().uuid(), note: z.string().trim().max(1000).default("") });
/** Someone has it: no one further is told. */
export async function acknowledgeAlarm(db: Kysely<DigifabDB>, orgId: string, userId: string, value: unknown) {
  const input = AckSchema.parse(value);
  const row = await db.updateTable("digifab_alarms").set({ acknowledged_by: userId, acknowledged_at: new Date(), next_escalation_at: null, note: input.note }).where("id", "=", input.alarm_id).where("acknowledged_at", "is", null).returningAll().executeTakeFirst();
  if (!row) throw new AlarmRefusal("That alarm is already acknowledged, or not here.");
  await platform().activity.log({ orgId, userId, action: "machine_alarm_acknowledged", ref: machineRef(row.machine_id), diff: { code: row.code, note: input.note } });
  return row;
}

const PolicySchema = z.object({
  operators: z.array(z.string().uuid()).max(50), supervisors: z.array(z.string().uuid()).max(50), integrators: z.array(z.string().uuid()).max(50),
  supervisor_after_minutes: z.number().int().min(1).max(1440), integrator_after_minutes: z.number().int().min(1).max(10080),
}).strict().refine((p) => p.integrator_after_minutes > p.supervisor_after_minutes, "The integrators are told after the supervisors.");
/** Who is told about alarms, and how long each level waits for an
 *  acknowledgement before the next is told. */
export async function setEscalation(db: Kysely<DigifabDB>, orgId: string, userId: string | null, value: unknown) {
  const p = PolicySchema.parse(value);
  for (const id of [...p.operators, ...p.supervisors, ...p.integrators]) if (!await platform().auth.userHasRole({ orgId, userId: id, minRole: "member" })) throw new AlarmRefusal("Choose people in this workspace.");
  const before = await escalationOf(db);
  const values = { operators: JSON.stringify(p.operators), supervisors: JSON.stringify(p.supervisors), integrators: JSON.stringify(p.integrators), supervisor_after_minutes: p.supervisor_after_minutes, integrator_after_minutes: p.integrator_after_minutes, updated_at: new Date() };
  await db.insertInto("digifab_alarm_escalation").values({ id: 1, ...values }).onConflict((oc) => oc.column("id").doUpdateSet(values)).execute();
  await platform().activity.log({ orgId, userId, action: "alarm_escalation_set", ref: { module: "digifab", entityType: "settings", entityId: "alarm-escalation" }, diff: { before: { ...before, updated_at: undefined }, after: p } });
  return { ok: true };
}

/** Each unacknowledged error alarm whose wait is up goes to the next level. */
export async function escalateDue(db: Kysely<DigifabDB>, orgId: string, now = new Date()) {
  const policy = await escalationOf(db);
  const due = await db.selectFrom("digifab_alarms").selectAll().where("acknowledged_at", "is", null).where("next_escalation_at", "<=", now).where("escalation_level", "<", 2).orderBy("occurred_at").limit(200).execute();
  const byLevel = new Map<number, Alarm[]>();
  for (const a of due) {
    const level = a.escalation_level + 1;
    const moved = await db.updateTable("digifab_alarms").set({ escalation_level: level, next_escalation_at: nextEscalationAt(level, a.occurred_at, policy) }).where("id", "=", a.id).where("escalation_level", "=", a.escalation_level).where("acknowledged_at", "is", null).returningAll().executeTakeFirst();
    if (moved) byLevel.set(level, [...(byLevel.get(level) ?? []), moved]);
  }
  await tell(orgId, 1, policy.supervisors, byLevel.get(1) ?? []);
  await tell(orgId, 2, policy.integrators, byLevel.get(2) ?? []);
  return { escalated: due.length };
}

export function registerAlarmEscalation(): void {
  platform().sweeps.register({ name: "digifab.alarm-escalation", module: "digifab", everyMs: 60_000, firstAfterMs: 30_000,
    visit: async ({ orgId, db }) => {
      try { await escalateDue(db as Kysely<DigifabDB>, orgId); }
      catch (err) { platform().health.notePassFailure("digifab.alarm-escalation", orgId, err); }
    },
  });
}

export async function readAlarms(db: Kysely<DigifabDB>, machineId: string, page: { limit: number; offset: number }) {
  const items = await db.selectFrom("digifab_alarms").selectAll().select(sql<string>`count(*) over()`.as("total")).where("machine_id", "=", machineId).orderBy("occurred_at", "desc").orderBy("id").limit(page.limit).offset(page.offset).execute();
  return { items: items.map(({ total: _t, ...a }) => a), total: Number(items[0]?.total ?? 0) };
}
