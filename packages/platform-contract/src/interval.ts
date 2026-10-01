// "Every N days, weeks, months or years": one calendar step rule, shared by
// everything that repeats (a service schedule, a repeating task), so "every
// month from the 31st" means the same date wherever it is asked.

import { countOf } from "@cobblr/platform-contract/plural";

export type IntervalUnit = "day" | "week" | "month" | "year";
export const INTERVAL_UNITS: readonly IntervalUnit[] = ["day", "week", "month", "year"];

/** `n` units after `from`. A month (or year) step keeps the day of the month
 *  where it can and clamps where it cannot. `anchorDay` is the day the SERIES
 *  falls on: stepping a series from its last occurrence, Feb 28 of a series on
 *  the 31st must give Mar 31, not Mar 28, and only the anchor can say so (the
 *  clamped date has forgotten it). Without one, `from`'s own day is used. */
export function addInterval(from: Date, n: number, unit: IntervalUnit, steps = 1, anchorDay?: number | null): Date {
  const d = new Date(from.getTime());
  const k = n * steps;
  if (unit === "day") return new Date(d.getTime() + k * 86_400_000);
  if (unit === "week") return new Date(d.getTime() + k * 7 * 86_400_000);
  const months = unit === "year" ? k * 12 : k;
  const day = anchorDay && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/** The day of the month a month or year series falls on, given one of its
 *  occurrences and the anchor it carried (if any). The anchor holds while the
 *  occurrence sits where the anchor puts it (the 28th of February IS the 31st
 *  clamped); a date someone moved by hand starts a new anchor from its own
 *  day. Null for day and week steps, which have no day of the month. */
export function seriesAnchorDay(due: Date, anchor: number | null | undefined, unit: IntervalUnit): number | null {
  if (unit !== "month" && unit !== "year") return null;
  const day = due.getUTCDate();
  if (!anchor || anchor < 1 || anchor > 31) return day;
  const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(anchor, lastDay) === day ? anchor : day;
}

/** "every 3 months", "every week". */
export function describeInterval(n: number, unit: IntervalUnit): string {
  return n === 1 ? `every ${unit}` : `every ${countOf(n, unit)}`;
}
