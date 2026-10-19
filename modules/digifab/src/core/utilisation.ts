// Observed utilisation for every machine (core spec #6883 §7): how long each
// was seen running, idle, in fault, or in a state it did not say, by the hour,
// and how much of the time it was seen at all. A sample counts the time since
// the machine's last sample in the state it was then, up to twice the
// sampling interval; a longer gap is time nobody saw, and the coverage says
// so. OEE is not computed: it needs planned time, an ideal rate and good and
// bad output, which a workspace does not keep yet.
import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "../db.js";
import { buildDriverById } from "../jobs-core.js";
import { classify } from "../state.js";
import { familyMachineStates, type MachineStateSample } from "./families.js";
import { raiseAlarm } from "./alarms.js";

export const SAMPLE_MS = 60_000;
const CAP_S = (2 * SAMPLE_MS) / 1000;
type State = MachineStateSample["state"];

/** A device's free-form state as one of the four. */
export function stateOf(deviceState: string | null | undefined): State {
  if (deviceState == null) return "unknown";
  const c = classify(deviceState);
  return c === "printing" ? "run" : c === "error" ? "fault" : c === "idle" || c === "paused" || c === "complete" ? "idle" : "unknown";
}

/** The seconds from `from` to `to` in each hour they span. */
export function splitByHour(from: Date, to: Date): Array<{ hour: Date; seconds: number }> {
  const out: Array<{ hour: Date; seconds: number }> = [];
  let t = from.getTime();
  while (t < to.getTime()) {
    const hour = Math.floor(t / 3_600_000) * 3_600_000, end = Math.min(hour + 3_600_000, to.getTime());
    out.push({ hour: new Date(hour), seconds: Math.round((end - t) / 1000) });
    t = end;
  }
  return out.filter((p) => p.seconds > 0);
}

/** Record one sample: the time since the last one goes to the state the
 *  machine was in then. Returns the state it left, when it changed. */
export async function recordSample(db: Kysely<DigifabDB>, s: MachineStateSample, now = new Date()): Promise<State | null> {
  const last = await db.selectFrom("digifab_utilisation_last").selectAll().where("machine_id", "=", s.machine_id).executeTakeFirst();
  if (!last) {
    await db.insertInto("digifab_utilisation_last").values({ machine_id: s.machine_id, state: s.state, detail: s.detail.slice(0, 300), seen_at: now }).onConflict((oc) => oc.column("machine_id").doNothing()).execute();
    return null;
  }
  // Another process that sampled first owns this interval: only one counts it.
  const moved = await db.updateTable("digifab_utilisation_last").set({ state: s.state, detail: s.detail.slice(0, 300), seen_at: now }).where("machine_id", "=", s.machine_id).where("seen_at", "=", last.seen_at).returning("machine_id").executeTakeFirst();
  if (!moved) return null;
  const elapsed = (now.getTime() - last.seen_at.getTime()) / 1000;
  if (elapsed > 0) {
    const counted = new Date(last.seen_at.getTime() + Math.min(elapsed, CAP_S) * 1000);
    const column = `${last.state}_s` as "run_s" | "idle_s" | "fault_s" | "unknown_s";
    for (const part of splitByHour(last.seen_at, counted)) {
      await db.insertInto("digifab_utilisation").values({ machine_id: s.machine_id, hour: part.hour, [column]: part.seconds })
        .onConflict((oc) => oc.columns(["machine_id", "hour"]).doUpdateSet({ [column]: sql`digifab_utilisation.${sql.ref(column)} + ${part.seconds}` })).execute();
    }
  }
  return last.state !== s.state ? last.state : null;
}

/** Every linked machine's state now: a family's own, then each bridge's
 *  device list for the rest. A connection that does not answer is unknown. */
export async function sampleMachines(db: Kysely<DigifabDB>, orgId: string): Promise<{ samples: MachineStateSample[]; own: Set<string> }> {
  const own = await familyMachineStates(db, orgId);
  const covered = new Set(own.map((s) => s.machine_id));
  const links = (await db.selectFrom("digifab_device_links").select(["connection_id", "remote_device_id", "machine_id"]).where("machine_id", "is not", null).execute()).filter((l) => !covered.has(l.machine_id!));
  const byConnection = new Map<string, typeof links>();
  for (const l of links) byConnection.set(l.connection_id, [...(byConnection.get(l.connection_id) ?? []), l]);
  const out = [...own];
  for (const [connection, rows] of byConnection) {
    let devices: Array<{ id: string; state?: string | null }> | null = null;
    // pass-catch: a bridge that does not answer is a reading, recorded as unknown time for its machines
    try { devices = (await (await buildDriverById(db, orgId, connection))?.listDevices()) ?? null; } catch { devices = null; }
    for (const l of rows) {
      const d = devices?.find((x) => x.id === l.remote_device_id);
      out.push({ machine_id: l.machine_id!, state: d ? stateOf(d.state) : "unknown", detail: d?.state ?? (devices ? "not reported" : "not answering") });
    }
  }
  return { samples: out, own: covered };
}

/** One pass: sample every machine, count the time, and raise an alarm for a
 *  machine that went into fault (an arm raises its own, in its own words). */
export async function sampleUtilisation(db: Kysely<DigifabDB>, orgId: string, now = new Date()) {
  const { samples, own } = await sampleMachines(db, orgId);
  for (const s of samples) {
    const left = await recordSample(db, s, now);
    if (left !== null && left !== "fault" && s.state === "fault" && !own.has(s.machine_id)) {
      await raiseAlarm(db, orgId, { machine_id: s.machine_id, source: "machine", source_ref: `fault:${now.toISOString()}`, code: "FAULT", text: `It reports ${s.detail}.`, severity: "error", occurred_at: now });
    }
  }
  return samples.length;
}

export function registerUtilisation(): void {
  platform().sweeps.register({ name: "digifab.utilisation", module: "digifab", everyMs: SAMPLE_MS, firstAfterMs: 20_000,
    visit: async ({ orgId, db }) => {
      try { await sampleUtilisation(db as Kysely<DigifabDB>, orgId); }
      catch (err) { platform().health.notePassFailure("digifab.utilisation", orgId, err); }
    },
  });
}

/** A machine's time over the last `hours`, and how much of it was seen. */
export async function readUtilisation(db: Kysely<DigifabDB>, machineId: string, hours: number, now = new Date()) {
  const since = new Date(Math.floor((now.getTime() - hours * 3_600_000) / 3_600_000) * 3_600_000);
  const rows = await db.selectFrom("digifab_utilisation").selectAll().where("machine_id", "=", machineId).where("hour", ">=", since).orderBy("hour").execute();
  const sum = (k: "run_s" | "idle_s" | "fault_s" | "unknown_s") => rows.reduce((n, r) => n + r[k], 0);
  const totals = { run_s: sum("run_s"), idle_s: sum("idle_s"), fault_s: sum("fault_s"), unknown_s: sum("unknown_s") };
  const window = Math.round((now.getTime() - since.getTime()) / 1000);
  const seen = totals.run_s + totals.idle_s + totals.fault_s + totals.unknown_s;
  const last = await db.selectFrom("digifab_utilisation_last").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
  return { since, window_s: window, ...totals, coverage: window ? Math.min(1, seen / window) : 0, hours: rows, now: last ?? null, oee: { available: false, needs: ["planned time", "an ideal rate", "good and bad output"] } };
}
