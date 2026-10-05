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

// The calendar step rule is shared with everything else that repeats.
import { addInterval, INTERVAL_UNITS, type IntervalUnit } from "@cobblr/platform-contract/interval";
export { addInterval, INTERVAL_UNITS, type IntervalUnit };

export type RenewalAnchor = string | { month: number; last_day: true };
export type OverdueCadence = "day" | "week" | "month" | "off";
export interface NagState { overdue_every?: OverdueCadence | null; nag_snoozed_until?: Date | null; nag_stopped_at?: Date | null }
export type Reminder = { before: number; unit: "day" | "week" | "month" } | { on: "month_start" };

export interface ScheduleRule {
  anchor?: RenewalAnchor | null;
  remind?: Reminder | null;
  /** Calendar interval: every `every_n` `every_unit`s. Null when counter-only. */
  every_n: number | null;
  every_unit: IntervalUnit | null;
  /** Usage interval: every `counter_every` of the record's `counter_field`. */
  counter_field: string | null;
  counter_every: number | null;
}

export interface ScheduleState extends ScheduleRule {
  current_expiry?: Date | null;
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

export function hasCalendar(r: ScheduleRule): r is ScheduleRule & { every_n: number; every_unit: IntervalUnit } {
  return typeof r.every_n === "number" && r.every_n > 0 && !!r.every_unit;
}

export function hasCounter(r: ScheduleRule): r is ScheduleRule & { counter_field: string; counter_every: number } {
  return !!r.counter_field && typeof r.counter_every === "number" && r.counter_every > 0;
}

/** When the next service is due by the calendar, or null for a counter-only
 *  schedule. */
export function nextDueAt(s: ScheduleState): Date | null {
  if (s.anchor) return s.current_expiry ?? null;
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
    const soon = reminderAt(at, s.remind);
    verdicts.push({ state: state === "overdue" ? state : dayIn(now, timeZone) >= dayIn(soon, timeZone) ? "due-soon" : "ok", reason });
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
  if (r.anchor) parts.push(typeof r.anchor === "string" ? `renew on ${r.anchor}` : `renew on the last day of month ${r.anchor.month}`);
  if (hasCalendar(r)) parts.push(`every ${r.every_n === 1 ? "" : `${r.every_n} `}${r.every_unit}${r.every_n === 1 ? "" : "s"}`);
  if (hasCounter(r)) parts.push(`${parts.length ? "" : "every "}${round(r.counter_every)} ${counterLabel}`);
  return parts.join(" or ");
}

export function nextRenewalExpiry(s: ScheduleState): Date | null {
  if (!s.anchor || !s.current_expiry || !hasCalendar(s)) return null;
  const step = addInterval(s.current_expiry, s.every_n, s.every_unit);
  const year = step.getUTCFullYear();
  const [month, day] = typeof s.anchor === "string" ? s.anchor.split("-").map(Number) : [s.anchor.month, null];
  const m = s.every_unit === "year" ? month! - 1 : step.getUTCMonth();
  const last = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, m, day == null ? last : Math.min(day, last), 12));
}

export function reminderAt(due: Date, remind?: Reminder | null): Date {
  if (remind && "on" in remind) return new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 1, 12));
  return addInterval(due, -(remind?.before ?? DUE_SOON_DAYS), remind?.unit ?? "day");
}

export function shouldNotify(due: Date, remind: Reminder | null | undefined, last: Date | null, now: Date, nag: NagState = {}): boolean {
  if (nag.nag_stopped_at || (nag.nag_snoozed_until && now < nag.nag_snoozed_until)) return false;
  const today = dayIn(now, "UTC");
  const reminder = dayIn(reminderAt(due, remind), "UTC");
  const expiry = dayIn(due, "UTC");
  if (today < reminder) return false;
  if (!last || dayIn(last, "UTC") < reminder) return true;
  const notified = dayIn(last, "UTC");
  if (today >= expiry && notified < expiry) return true;
  const cadence = nag.overdue_every ?? "week";
  if (cadence === "off" || today <= expiry) return false;
  return dayIn(now, "UTC") >= dayIn(addInterval(last, 1, cadence), "UTC");
}


export function nextReminderAt(due: Date, remind: Reminder | null, last: Date | null, now: Date, nag: NagState = {}): Date | null {
  if (nag.nag_stopped_at) return null;
  const lead = reminderAt(due, remind);
  let next: Date | null;
  if (!last || dayIn(last, "UTC") < dayIn(lead, "UTC")) next = lead;
  else if (dayIn(last, "UTC") < dayIn(due, "UTC")) next = due;
  else next = nag.overdue_every === "off" ? null : addInterval(last, 1, nag.overdue_every ?? "week");
  if (next && nag.nag_snoozed_until && next < nag.nag_snoozed_until) next = nag.nag_snoozed_until;
  return next && next < now ? now : next;
}
