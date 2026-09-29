// A maintenance schedule: "service this every 3 months", or "every 200 print
// hours" for a machine that counts its use. Pure arithmetic, no database, so
// the rules a person reads on the record and the rules the sweeper acts on
// are the same functions (and are tested without a workspace).
//
// A schedule is due by the calendar, by a counter, or by whichever comes
// first when it has both. Logging the service rolls it forward from when the
// work was DONE (and the counter reading at that moment), not from when it
// was due: an oil change done a month late starts the next three months from
// the day it was actually changed.

import { dayIn, daysUntil } from "@cobblr/platform-contract/day";

export type IntervalUnit = "day" | "week" | "month" | "year";
export const INTERVAL_UNITS: readonly IntervalUnit[] = ["day", "week", "month", "year"];

export interface ScheduleRule {
  /** Calendar interval: every `every_n` `every_unit`s. Null when counter-only. */
  every_n: number | null;
  every_unit: IntervalUnit | null;
  /** Usage interval: every `counter_every` of the record's `counter_field`. */
  counter_field: string | null;
  counter_every: number | null;
}

export interface ScheduleState extends ScheduleRule {
  last_done_at: Date | null;
  last_done_counter: number | null;
  /** When the schedule started, for one never done: the first due date is
   *  counted from here. */
  created_at: Date;
}

/** How far ahead "due soon" reaches, by the calendar and by the counter. */
export const DUE_SOON_DAYS = 7;
/** A tenth of the interval, so "every 200 hours" warns at 180. */
export const DUE_SOON_COUNTER_FRACTION = 0.1;

/** `n` units after `from`. A month step keeps the day of the month where it
 *  can and clamps where it cannot: every month from Jan 31 is Feb 28/29, then
 *  Mar 31, because each step is counted from the original day, not from the
 *  clamped one. */
export function addInterval(from: Date, n: number, unit: IntervalUnit, steps = 1): Date {
  const d = new Date(from.getTime());
  const k = n * steps;
  if (unit === "day") return new Date(d.getTime() + k * 86_400_000);
  if (unit === "week") return new Date(d.getTime() + k * 7 * 86_400_000);
  const months = unit === "year" ? k * 12 : k;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export function hasCalendar(r: ScheduleRule): r is ScheduleRule & { every_n: number; every_unit: IntervalUnit } {
  return typeof r.every_n === "number" && r.every_n > 0 && !!r.every_unit;
}

export function hasCounter(r: ScheduleRule): r is ScheduleRule & { counter_field: string; counter_every: number } {
  return !!r.counter_field && typeof r.counter_every === "number" && r.counter_every > 0;
}

/** When the next service is due by the calendar, or null for a counter-only
 *  schedule. */
export function nextDueAt(s: ScheduleState): Date | null {
  if (!hasCalendar(s)) return null;
  return addInterval(s.last_done_at ?? s.created_at, s.every_n, s.every_unit);
}

/** The counter reading at which the next service is due, or null. A schedule
 *  never done counts from the reading when it was set (`last_done_counter` is
 *  stamped then), or from zero when there was none. */
export function nextDueCounter(s: ScheduleState): number | null {
  if (!hasCounter(s)) return null;
  return (s.last_done_counter ?? 0) + s.counter_every;
}

export type DueState = "ok" | "due-soon" | "overdue";

export interface Due {
  state: DueState;
  /** Why, in words a person reads on the record: "due in 5 days",
   *  "overdue by 12 hours of use". */
  reason: string;
  next_due_at: Date | null;
  next_due_counter: number | null;
}

/** Where a calendar due date stands, read as whole days in one zone: the
 *  due day against today, never an instant divided into days. The record's
 *  schedule and the Maintenance page's list both say this, so they cannot
 *  disagree: they used to be 9 and 10 days overdue for one printer, one
 *  rounding up and the other to the nearest (#3991). `timeZone` is the
 *  reader's; without one, the day that has arrived everywhere. */
export function calendarDue(at: Date, now: Date, timeZone?: string | null): { state: DueState; reason: string; days: number } {
  const d = daysUntil(dayIn(at, timeZone), dayIn(now, timeZone));
  if (d < 0) return { state: "overdue", reason: `overdue by ${-d} day${-d === 1 ? "" : "s"}`, days: d };
  if (d === 0) return { state: "due-soon", reason: "due today", days: d };
  if (d <= DUE_SOON_DAYS) return { state: "due-soon", reason: `due in ${d} day${d === 1 ? "" : "s"}`, days: d };
  return { state: "ok", reason: `due in ${d} days`, days: d };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Where a schedule stands now: the worse of its calendar and its counter.
 *  `counter` is the record's current reading, or null when it has none. */
export function dueState(s: ScheduleState, now: Date, counter: number | null, counterLabel = "use", timeZone?: string | null): Due {
  const at = nextDueAt(s);
  const mark = nextDueCounter(s);
  const verdicts: { state: DueState; reason: string }[] = [];
  if (at) {
    const { state, reason } = calendarDue(at, now, timeZone);
    verdicts.push({ state, reason });
  }
  if (mark != null && counter != null && hasCounter(s)) {
    const left = mark - counter;
    if (left <= 0) verdicts.push({ state: "overdue", reason: `overdue by ${round(-left)} ${counterLabel}` });
    else if (left <= s.counter_every * DUE_SOON_COUNTER_FRACTION) verdicts.push({ state: "due-soon", reason: `due in ${round(left)} ${counterLabel}` });
    else verdicts.push({ state: "ok", reason: `due in ${round(left)} ${counterLabel}` });
  }
  const rank: Record<DueState, number> = { ok: 0, "due-soon": 1, overdue: 2 };
  const worst = verdicts.sort((a, b) => rank[b.state] - rank[a.state])[0] ?? { state: "ok" as const, reason: "no due date yet" };
  return { ...worst, next_due_at: at, next_due_counter: mark };
}

/** "every 3 months", "every 200 print hours", "every 3 months or 200 print
 *  hours". */
export function describeRule(r: ScheduleRule, counterLabel = "use"): string {
  const parts: string[] = [];
  if (hasCalendar(r)) parts.push(`every ${r.every_n === 1 ? "" : `${r.every_n} `}${r.every_unit}${r.every_n === 1 ? "" : "s"}`);
  if (hasCounter(r)) parts.push(`${parts.length ? "" : "every "}${round(r.counter_every)} ${counterLabel}`);
  return parts.join(" or ");
}
