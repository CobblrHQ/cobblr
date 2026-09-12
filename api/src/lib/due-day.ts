// Overdue, due today, or coming up: by DAY, the way the schedule reads it.
//
// The attention feed compared a due date to the clock: a date is midnight, so
// anything due TODAY was "overdue" from 00:01. The dashboard's schedule beside
// it buckets by day and put the same yogurt under today. So a first screen
// read "6 overdue" on top of "5 overdue, 1 today" and the two looked like a
// counting bug (2026-09-12). One rule, by calendar day, for both; the client
// sends its own day so a workspace in another timezone is not "overdue" a few
// hours early.

import { arrivedEverywhere } from "@cobblr/platform-contract";

export type DueState = "overdue" | "today" | "upcoming" | "later" | "none";

/** `date` and `today` are YYYY-MM-DD (any ISO timestamp's first ten
 *  characters). `windowDays` bounds "upcoming". */
export function dueState(date: string | null | undefined, today: string, windowDays: number): DueState {
  const day = typeof date === "string" ? date.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "none";
  if (day < today) return "overdue";
  if (day === today) return "today";
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + windowDays);
  return day <= end.toISOString().slice(0, 10) ? "upcoming" : "later";
}

/** The client's day when it sends one (YYYY-MM-DD), else the day that has
 *  arrived everywhere, so a server clock never calls something overdue before
 *  the person's own day has ended. */
export function todayFrom(query: unknown, now: Date = new Date()): string {
  return typeof query === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query) ? query : arrivedEverywhere(now);
}
