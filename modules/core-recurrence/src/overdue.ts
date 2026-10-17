// The overdue sweep: what turns a deadline that came and went into a signal
// that gets louder, once per step (household-accountability.md section 3).
//
// Each day it reads every record at or past its deadline (the platform's
// `calendar.overdue`: a task's due date, and any date field declared `due`),
// works out which tier each has reached, and emits
//   core-recurrence.overdue { entityKind, entityId, <kindSuffix>Id,
//                             daysOverdue, tier, assigneeUserId }
// Tiers are emitted, not enforced: a wire decides what a tier deserves.
//
//   due    the day it is due
//   late   one or two days over
//   stale  three days or more
//
// Two things it must get right, both paid for by the cadence sweeper:
//  1. Publish `<kindSuffix>Id`, through the BASE kind: the wire engine
//     resolves the source record from it, and `entityId` alone matched nothing.
//  2. Debounce per (record, tier): saying "the bins are overdue" every hour
//     trains people to ignore it. core_recurrence_overdue_signals remembers.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { arrivedEverywhere, daysUntil, platform, sourceIdKey } from "@cobblr/platform-contract";

export const OVERDUE_PASS = "core-recurrence.overdue";
export const OVERDUE_EVENT = "core-recurrence.overdue";
const TICK_MS = 60 * 60 * 1000;
/** The last day a record is "late"; past it, it is "stale". */
export const LATE_UNTIL_DAYS = 2;

export type OverdueTier = "due" | "late" | "stale";

/** Whole days between two YYYY-MM-DD days. */
export function daysOverdue(dueOn: string, today: string): number {
  return 0 - daysUntil(dueOn, today);
}

/** The tier a record has reached, or null when it is not yet due. */
export function overdueTier(days: number): OverdueTier | null {
  if (days < 0) return null;
  if (days === 0) return "due";
  return days <= LATE_UNTIL_DAYS ? "late" : "stale";
}

interface SignalsDB {
  core_recurrence_overdue_signals: {
    entity_kind: string;
    entity_id: string;
    tier: OverdueTier;
    due_on: string;
    last_emitted: Date;
  };
}

export function startOverdueSweeper(): void {
  platform().sweeps.register({
    name: OVERDUE_PASS,
    everyMs: TICK_MS,
    module: "core-recurrence",
    visit: ({ orgId, db }) => visitWorkspace(orgId, db),
  });
}

/** Exported for the route that runs one sweep now (tests, ops). */
export async function overdueTick(opts: { orgId?: string } = {}): Promise<{ scanned: number; emitted: number }> {
  const run = await platform().sweeps.run(OVERDUE_PASS, { orgIds: opts.orgId ? [opts.orgId] : undefined });
  let scanned = 0;
  let emitted = 0;
  for (const { result } of run.results) {
    const r = result as Partial<{ scanned: number; emitted: number }> | void;
    scanned += r?.scanned ?? 0;
    emitted += r?.emitted ?? 0;
  }
  return { scanned, emitted };
}

async function visitWorkspace(orgId: string, raw: unknown): Promise<{ scanned: number; emitted: number }> {
  const tdb = raw as Kysely<SignalsDB>;
  const today = arrivedEverywhere(new Date());
  const rows = await platform().calendar.overdue(orgId, today);
  let emitted = 0;
  const stillLate: Array<{ kind: string; id: string }> = [];

  for (const r of rows) {
    const days = daysOverdue(r.dueOn, today);
    const tier = overdueTier(days);
    if (!tier) continue;
    stillLate.push({ kind: r.kind, id: r.id });

    const prev = await tdb
      .selectFrom("core_recurrence_overdue_signals")
      .select(["due_on"])
      .where("entity_kind", "=", r.kind)
      .where("entity_id", "=", r.id)
      .where("tier", "=", tier)
      .executeTakeFirst();
    if (prev && String(prev.due_on).slice(0, 10) === r.dueOn) continue;

    // A resolver that cannot name the base kind must skip the emit: an
    // instance kind's own suffix is a key nobody listens for.
    const baseKind = await platform().entities.baseKindOf(orgId, r.kind);
    if (!baseKind) {
      console.warn(`[core-recurrence] no base kind for ${r.kind}, skipping overdue signal`);
      continue;
    }
    // The wire fires only for a signal that was recorded: write first, so a
    // crash between the two says it twice at worst, never silently never.
    await tdb
      .insertInto("core_recurrence_overdue_signals")
      .values({ entity_kind: r.kind, entity_id: r.id, tier, due_on: r.dueOn, last_emitted: new Date() })
      .onConflict((oc) => oc.columns(["entity_kind", "entity_id", "tier"]).doUpdateSet({ due_on: r.dueOn, last_emitted: new Date() }))
      .execute();

    // Who has it, as a login: a person with no account has no channel, and
    // the household hears instead (the wires read the absence).
    const assigneeUserId = r.assigneePersonId ? await platform().accounts.userForPerson(orgId, r.assigneePersonId).catch(() => null) : null;
    const payload = {
      orgId,
      entityKind: r.kind,
      entityId: r.id,
      [sourceIdKey(baseKind)]: r.id,
      title: r.name,
      dueOn: r.dueOn,
      daysOverdue: days,
      tier,
      assigneeUserId,
    };
    // The one event carries the tier; the per-tier names are the same signal
    // for a wire that is about one step (the defaults are: a wire is keyed on
    // its kind, action and event, so three tiers need three events).
    void platform().events.emit(OVERDUE_EVENT, payload);
    void platform().events.emit(tier === "due" ? "core-recurrence.overdue.due" : tier === "late" ? "core-recurrence.overdue.late" : "core-recurrence.overdue.stale", payload);
    emitted++;
  }

  // Done, deleted or re-dated out of lateness: forget it, so the next time it
  // is late it starts at the first tier. One statement per kind keeps it cheap.
  const keep = new Map<string, string[]>();
  for (const s of stillLate) keep.set(s.kind, [...(keep.get(s.kind) ?? []), s.id]);
  const kept = [...keep.entries()];
  await sql`
    delete from core_recurrence_overdue_signals
    where not (${kept.length ? sql.join(kept.map(([k, ids]) => sql`(entity_kind = ${k} and entity_id::text = any(${ids}))`), sql` or `) : sql`false`})
  `.execute(tdb);

  return { scanned: rows.length, emitted };
}
