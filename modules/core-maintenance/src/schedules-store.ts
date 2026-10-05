// Where a schedule meets the service log (#3876).
//
// A schedule's due occurrence is an ordinary scheduled entry carrying
// schedule_id, so everything that already reads the log (the sweeper's
// due-soon pass, the calendar, the maintenance page, the assistant's
// list_maintenance) sees it with no second path. Three moments move it:
//   - setting a schedule makes its first occurrence;
//   - logging the service rolls it forward from when the work was DONE and
//     makes the next one;
//   - the sweeper makes an occurrence a counter has just made due, and moves
//     an open one earlier when the counter passes its mark before its date.
//
// A counter is read through the kernel (entities.readCounters): a module's own
// counters through its writer, and any number field marked `usage` from the
// record, so only the machines module reads machines_machines.

import { MaintenanceRefusal } from "./refusal.js";
import { platform } from "@cobblr/platform-contract";
import { sql, type Kysely, type Selectable } from "kysely";
import type { CoreMaintenanceDB, CoreMaintenanceEntriesTable, CoreMaintenanceSchedulesTable } from "./db.js";
import { dueState, hasCounter, nextRenewalExpiry, reminderAt, addInterval, type Due, type ScheduleState } from "./schedule.js";

export type ScheduleRow = Selectable<CoreMaintenanceSchedulesTable>;
type EntryRow = Selectable<CoreMaintenanceEntriesTable>;
type Db = Kysely<CoreMaintenanceDB>;

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export function kindOf(row: { entity_module: string; entity_type: string }): string {
  return `${row.entity_module}:${row.entity_type}`;
}

export function stateOf(s: ScheduleRow): ScheduleState {
  return {
    anchor: s.anchor,
    remind: s.remind,
    current_expiry: s.current_expiry,
    every_n: s.every_n,
    every_unit: s.every_unit,
    counter_field: s.counter_field,
    counter_every: num(s.counter_every),
    last_done_at: s.last_done_at,
    last_done_counter: num(s.last_done_counter),
    created_at: s.created_at,
  };
}

/** The counters a kind keeps, for the "every [200] [print hours ▾]" choice. */
export async function counterDefs(orgId: string, kind: string): Promise<readonly { key: string; label: string }[]> {
  return platform().entities.countersFor(orgId, kind).catch(() => []);
}

/** One record's current reading of one counter, or null when it has none. */
export async function readCounter(orgId: string, kind: string, id: string, field: string): Promise<number | null> {
  const values = await platform().entities.readCounters(orgId, kind, id).catch(() => ({}) as Record<string, number | null>);
  return values[field] ?? null;
}

export async function counterLabel(orgId: string, kind: string, field: string | null): Promise<string> {
  if (!field) return "use";
  return (await counterDefs(orgId, kind)).find((d) => d.key === field)?.label ?? field.replace(/_/g, " ");
}

/** Where a schedule stands now, with its counter read. */
export async function dueOf(orgId: string, s: ScheduleRow, now = new Date(), timeZone?: string | null): Promise<Due & { counter: number | null; counter_label: string; reminder_at: Date | null }> {
  const state = await renewalState(orgId, s);
  const kind = kindOf(s);
  const counter = hasCounter(state) ? await readCounter(orgId, kind, s.entity_id, state.counter_field) : null;
  const label = await counterLabel(orgId, kind, s.counter_field);
  return { ...dueState(state, now, counter, label, timeZone), counter, counter_label: label, reminder_at: nextDueAtReminder(state) };
}

async function openOccurrences(db: Db, scheduleId: string): Promise<EntryRow[]> {
  return db
    .selectFrom("core_maintenance_entries")
    .selectAll()
    .where("schedule_id", "=", scheduleId)
    .where("performed_at", "is", null)
    .orderBy("scheduled_at", "asc")
    .execute();
}

/** Make sure the schedule has exactly one open occurrence when it should, at
 *  the right date: its calendar date, or now when its counter has passed the
 *  mark. Idempotent; the sweeper calls it every pass. Returns the occurrence,
 *  or null for a counter schedule not yet due. */
export async function ensureOccurrence(db: Db, orgId: string, s: ScheduleRow, now = new Date()): Promise<EntryRow | null> {
  const run = async (tx: Db) => {
    const current = await tx.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", s.id).forUpdate().executeTakeFirst();
    return current ? ensureOccurrenceLocked(tx, orgId, current, now) : null;
  };
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

async function ensureOccurrenceLocked(db: Db, orgId: string, s: ScheduleRow, now: Date): Promise<EntryRow | null> {
  const due = await dueOf(orgId, s, now);
  const byCounter = due.counter != null && due.next_due_counter != null && due.counter >= due.next_due_counter;
  const target = byCounter ? now : due.next_due_at;
  const open = await openOccurrences(db, s.id);
  const [first, ...extra] = open;
  // Two open occurrences of one schedule is one too many: a race between a
  // log and a sweep. Keep the earliest.
  for (const e of extra) await db.deleteFrom("core_maintenance_entries").where("id", "=", e.id).execute();
  if (!target) {
    if (s.anchor && first) { await db.deleteFrom("core_maintenance_entries").where("id", "=", first.id).execute(); return null; }
    return first ?? null;
  }
  if (first) {
    if (first.scheduled_at && (byCounter ? first.scheduled_at.getTime() > target.getTime() : first.scheduled_at.getTime() !== target.getTime())) {
      return db
        .updateTable("core_maintenance_entries")
        .set({ scheduled_at: target, last_notified_at: null, updated_at: new Date() })
        .where("id", "=", first.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return first;
  }
  return db
    .insertInto("core_maintenance_entries")
    .values({
      entity_module: s.entity_module,
      entity_type: s.entity_type,
      entity_id: s.entity_id,
      name: s.name,
      scheduled_at: target,
      schedule_id: s.id,
    } as never)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** The schedule a logged service belongs to: the one it names, else the
 *  record's schedule with the same name ("Oil change" logged on a car with an
 *  "oil change" schedule). */
async function scheduleFor(db: Db, entry: EntryRow): Promise<ScheduleRow | null> {
  if (entry.schedule_id) {
    const byId = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", entry.schedule_id).forUpdate().executeTakeFirst();
    if (byId) return byId;
  }
  const rows = await db
    .selectFrom("core_maintenance_schedules")
    .selectAll()
    // By the record's id alone: one printer is reached as its base kind from
    // one surface and as its instance's kind from another, and a match on the
    // kind spelling would miss the schedule the other surface set.
    .where("entity_id", "=", entry.entity_id)
    .execute();
  const key = entry.name.trim().toLowerCase();
  return rows.find((r) => r.name.trim().toLowerCase() === key) ?? null;
}

/** A service was done: roll its schedule forward from when it was done, close
 *  the occurrence it satisfied, and make the next one. Nothing happens for an
 *  entry that is not done yet or that no schedule matches. Never throws into
 *  the caller: the log is already written, and a schedule that failed to roll
 *  is caught up by the next sweep. */
export interface RolledFrom {
  schedule_id: string;
  last_done_at: string | null;
  last_done_counter: number | null;
  current_expiry?: string | null;
}

async function rollForwardLocked(
  db: Db,
  orgId: string,
  entry: EntryRow,
  newExpiry?: Date,
): Promise<{ schedule_id: string; next: EntryRow | null; was: RolledFrom } | null> {
  if (!entry.performed_at) return null;
  try {
    const s = await scheduleFor(db, entry);
    if (entry.schedule_id && entry.entity_id !== s?.entity_id) throw new Error("The schedule belongs to another record");
    if (!s) return null;
    // A service logged for a date before the schedule's last one (entering old
    // history) is history only; it must not move the schedule backwards.
    if (s.last_done_at && entry.performed_at.getTime() < s.last_done_at.getTime()) {
      if (newExpiry) throw new MaintenanceRefusal("This renewal predates the last renewal. Log it as history instead.");
      return null;
    }
    const renewal = await renewalState(orgId, s);
    const expiry = newExpiry ?? nextRenewalExpiry(renewal);
    if (expiry) await writeExpiry(orgId, s, expiry);
    const reading = s.counter_field ? await readCounter(orgId, kindOf(s), s.entity_id, s.counter_field) : null;
    const rolled = await db
      .updateTable("core_maintenance_schedules")
      .set({
        ...(expiry && !s.expiry_field ? { current_expiry: expiry } : {}),
        last_done_at: entry.performed_at,
        last_done_counter: reading ?? num(s.last_done_counter),
        updated_at: new Date(),
      })
      .where("id", "=", s.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (entry.schedule_id !== s.id) {
      await db.updateTable("core_maintenance_entries").set({ schedule_id: s.id }).where("id", "=", entry.id).execute();
    }
    // The occurrence this service satisfied, if it was not itself the entry.
    await db
      .deleteFrom("core_maintenance_entries")
      .where("schedule_id", "=", s.id)
      .where("performed_at", "is", null)
      .where("id", "!=", entry.id)
      .execute();
    const next = await ensureOccurrence(db, orgId, rolled);
    const was: RolledFrom = {
      schedule_id: s.id,
      current_expiry: renewal.current_expiry?.toISOString() ?? null,
      last_done_at: s.last_done_at ? s.last_done_at.toISOString() : null,
      last_done_counter: num(s.last_done_counter),
    };
    return { schedule_id: s.id, next, was };
  } catch (err) {
    if (newExpiry) throw err;
    console.warn(`[core-maintenance] roll-forward for entry ${entry.id} failed:`, (err as Error).message);
    return null;
  }
}

/** Every schedule in the workspace brought up to date: the sweeper's pass. */
export async function reconcileSchedules(db: Db, orgId: string, now = new Date()): Promise<{ schedules: number; reasons: Map<string, string> }> {
  const rows = await db.selectFrom("core_maintenance_schedules").selectAll().execute();
  const reasons = new Map<string, string>();
  for (const s of rows) {
    try {
      await ensureOccurrence(db, orgId, s, now);
      const due = await dueOf(orgId, s, now);
      reasons.set(s.id, due.reason);
    } catch (err) {
      console.warn(`[core-maintenance] schedule ${s.id} not reconciled:`, (err as Error).message);
    }
  }
  return { schedules: rows.length, reasons };
}


/** Undo of a logged service: the schedule goes back to when it was last done
 *  before, and its occurrence to the date that implies. */
export async function unroll(db: Db, orgId: string, was: RolledFrom): Promise<void> {
  const s = await db
    .updateTable("core_maintenance_schedules")
    .set({
      ...(was.current_expiry !== undefined ? { current_expiry: sql<Date | null>`case when expiry_field is null then ${was.current_expiry ? new Date(was.current_expiry) : null}::timestamptz else null end` } : {}),
      last_done_at: was.last_done_at ? new Date(was.last_done_at) : null,
      last_done_counter: was.last_done_counter,
      updated_at: new Date(),
    })
    .where("id", "=", was.schedule_id)
    .returningAll()
    .executeTakeFirst();
  if (!s) return;
  if (s.expiry_field && was.current_expiry) await writeExpiry(orgId, s, new Date(was.current_expiry));
  await db.deleteFrom("core_maintenance_entries").where("schedule_id", "=", s.id).where("performed_at", "is", null).execute();
  await ensureOccurrence(db, orgId, s);
}

export function rolledFromOf(v: unknown): RolledFrom | null {
  const r = v as Partial<RolledFrom> | null;
  if (!r || typeof r.schedule_id !== "string") return null;
  return {
    schedule_id: r.schedule_id,
    ...(r.current_expiry !== undefined ? { current_expiry: r.current_expiry } : {}),
    last_done_at: typeof r.last_done_at === "string" ? r.last_done_at : null,
    last_done_counter: typeof r.last_done_counter === "number" ? r.last_done_counter : null,
  };
}

export async function renewalState(orgId: string, s: ScheduleRow): Promise<ScheduleState> {
  const state = stateOf(s);
  if (!s.anchor || !s.expiry_field) return state;
  const record = await platform().entities.lookup(orgId, kindOf(s), s.entity_id);
  const fields = record?.fields ?? {};
  const metadata = (fields.metadata ?? {}) as Record<string, unknown>;
  const value = metadata[s.expiry_field] ?? fields[s.expiry_field];
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(value.slice(0, 10) + "T12:00:00Z") : null;
  state.current_expiry = date && Number.isFinite(date.getTime()) ? date : null;
  if (state.current_expiry && typeof state.anchor === "string") state.anchor = state.current_expiry.toISOString().slice(5, 10);
  if (state.current_expiry && typeof state.anchor === "object" && state.anchor) state.anchor = { month: state.current_expiry.getUTCMonth() + 1, last_day: true };
  return state;
}

function nextDueAtReminder(s: ScheduleState): Date | null {
  const due = s.anchor ? s.current_expiry : s.every_n && s.every_unit ? addInterval(s.last_done_at ?? s.created_at, s.every_n, s.every_unit) : null;
  return due ? reminderAt(due, s.remind) : null;
}

export async function writeExpiry(orgId: string, s: Pick<ScheduleRow, "expiry_field" | "entity_module" | "entity_type" | "entity_id">, expiry: Date): Promise<void> {
  if (!s.expiry_field) return;
  const changed = await platform().entities.mergeMetadata(orgId, kindOf(s), s.entity_id, { [s.expiry_field]: expiry.toISOString().slice(0, 10) });
  if (!changed) throw new Error("This record cannot store an expiry date");
}

export async function rollForward(db: Db, orgId: string, entry: EntryRow, newExpiry?: Date) {
  return db.isTransaction ? rollForwardLocked(db, orgId, entry, newExpiry) : db.transaction().execute((tx) => rollForwardLocked(tx, orgId, entry, newExpiry));
}


export async function completeEntry(db: Db, orgId: string, id: string, userId: string | null, at: Date) {
  return db.transaction().execute(async (tx) => {
    const before = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).executeTakeFirst();
    if (!before) return null;
    if (before.schedule_id) await tx.selectFrom("core_maintenance_schedules").select("id").where("id", "=", before.schedule_id).forUpdate().executeTakeFirst();
    const row = await tx.updateTable("core_maintenance_entries").set({ performed_at: at, performed_by: userId, updated_at: new Date() }).where("id", "=", id).where("performed_at", "is", null).returningAll().executeTakeFirst();
    if (!row) {
      const current = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      return { row: current, rolled: null, before, skipped: true };
    }
    const rolled = await rollForward(tx, orgId, row);
    return { row, rolled, before, skipped: false };
  });
}
