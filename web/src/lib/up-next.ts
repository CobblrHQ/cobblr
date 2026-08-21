// "Up next" — the dashboard's one time-shaped view.
//
// The dashboard was three per-module COUNTS (parts, labels queued, open
// tasks). A count is a number that barely moves and never tells you to do
// anything; you read it once and stop looking. What a workshop actually wants
// from a home page is what is late, what is today, and what is coming.
//
// No new plumbing: the workspace calendar already aggregates every module's
// registered CalendarSource — maintenance schedules, task due dates, expected
// deliveries, expiry dates, and a GENERIC source that turns every `type:"date"`
// custom field on every kind into an event. So any bundle that defines a date
// field already feeds this without anyone wiring it up. The data was being
// collected and shown only on a month grid nobody opens daily.
//
// This file is the part worth testing on its own: what "late" means, and how a
// flat list of dated things becomes four buckets.

import type { CalendarEvent } from "./api";

export type BucketId = "overdue" | "today" | "week" | "later";

export interface Bucket {
  id: BucketId;
  label: string;
  items: CalendarEvent[];
}

/** How far back to look for things still not done. A year, because "overdue"
 *  has no natural floor — a filter change three months ago is still not done
 *  today — while an unbounded query would make every source scan its whole
 *  table for a card. */
export const OVERDUE_WINDOW_DAYS = 365;
/** How far forward. Past a quarter, "later" stops being a to-do list and
 *  becomes a calendar, which the calendar page already is. */
export const AHEAD_WINDOW_DAYS = 90;

/** Local calendar day as YYYY-MM-DD.
 *
 *  LOCAL, not UTC. Events are all-day dates ("2026-08-20") produced in the
 *  workspace's own terms; comparing them against a UTC "today" puts everything
 *  due today into Overdue for anyone west of Greenwich after 5pm, which is the
 *  exact hour someone checks what is left. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

/** The window to ask the calendar endpoint for. */
export function upNextWindow(now: Date): { from: string; to: string } {
  return {
    from: dayKey(shiftDays(now, -OVERDUE_WINDOW_DAYS)),
    to: dayKey(shiftDays(now, AHEAD_WINDOW_DAYS)),
  };
}

/** Sort by date, then title, so the order is stable across refetches — two
 *  things due the same day must not swap places when you blink. */
function byDate(a: CalendarEvent, b: CalendarEvent): number {
  return a.date.localeCompare(b.date) || a.title.localeCompare(b.title);
}

/** Split dated events into overdue / today / this week / later.
 *
 *  "This week" is the next SEVEN DAYS, not the rest of the calendar week. On a
 *  Saturday the calendar-week reading leaves one day in the bucket and dumps
 *  everything else into "later", which is when you least want that. */
export function bucketEvents(events: readonly CalendarEvent[], now: Date): Bucket[] {
  const today = dayKey(now);
  const weekEnd = dayKey(shiftDays(now, 7));
  const overdue: CalendarEvent[] = [];
  const onToday: CalendarEvent[] = [];
  const week: CalendarEvent[] = [];
  const later: CalendarEvent[] = [];

  for (const e of events) {
    const day = e.date.slice(0, 10);
    if (day < today) overdue.push(e);
    else if (day === today) onToday.push(e);
    else if (day <= weekEnd) week.push(e);
    else later.push(e);
  }

  // Overdue newest-first: the thing that just slipped is the one you can still
  // do something about, and a year-old item at the top would push it off.
  overdue.sort((a, b) => byDate(b, a));
  for (const list of [onToday, week, later]) list.sort(byDate);

  return [
    { id: "overdue", label: "Overdue", items: overdue },
    { id: "today", label: "Today", items: onToday },
    { id: "week", label: "Next 7 days", items: week },
    { id: "later", label: "Later", items: later },
  ];
}

/** "3 days ago" / "in 2 weeks" — a distance, because a date makes you do the
 *  subtraction yourself, and the whole point of this card is not making you
 *  think. */
export function relativeDay(dateISO: string, now: Date): string {
  const day = dateISO.slice(0, 10);
  const today = dayKey(now);
  if (day === today) return "today";
  const diff = Math.round(
    (Date.parse(`${day}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000,
  );
  const n = Math.abs(diff);
  const unit = n === 1 ? "day" : n < 14 ? "days" : n < 60 ? "weeks" : "months";
  const size = n < 14 ? n : n < 60 ? Math.round(n / 7) : Math.round(n / 30);
  if (diff < 0) return n === 1 ? "yesterday" : `${size} ${unit} ago`;
  return n === 1 ? "tomorrow" : `in ${size} ${unit}`;
}
