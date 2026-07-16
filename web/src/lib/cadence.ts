// Expected-cadence scoring for the heatmap overlay (the pure half).
//
// A heatmap shows what you DID (one square per day, shaded by how many rows
// landed on it). On its own it can't tell "I wasn't supposed to run today" from
// "I skipped my run" — every gap looks identical. The overlay fixes that: the
// view declares the cadence it EXPECTS, those days get outlined, and a gap in an
// outlined day is a genuine miss while an un-outlined gap is just a rest day.
//
// The cadence is an RRULE string — the SAME vocabulary core-recurrence schedules
// on (wire `trigger_schedule`, per-entity rrule fields), so a workspace only ever
// learns one way to say "every weekday". Expansion (in ./cadence-expand) uses the
// same `rrule` package the scheduler uses rather than a hand-rolled subset:
// RRULE is a spec, and a near-enough parser silently mis-draws the grid.
//
// Pure + framework-free so the math is testable without a browser.
//
// This module must NOT import `rrule`: ViewsPage is imported EAGERLY by App, so
// anything it pulls in lands on the first-load path for every user, most of whom
// never open a heatmap. The rrule expansion therefore lives in the sibling
// `cadence-expand.ts`, which the renderer dynamic-imports only when a view
// actually declares a cadence — the same rule the vite config states for
// three.js and @zxing. Everything here is dependency-free by design.
// See docs/design-decisions/one-record-substrate.md.

/** The cadences the picker offers, in the RRULE vocabulary. `custom` lets an
 *  author paste any RRULE the spec allows; `""` means no expectation (the plain
 *  count grid, which is the default). */
export const CADENCE_PRESETS: ReadonlyArray<{ label: string; rrule: string }> = [
  { label: "Every day", rrule: "FREQ=DAILY" },
  { label: "Weekdays", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { label: "Every week", rrule: "FREQ=WEEKLY" },
  { label: "Every 2 weeks", rrule: "FREQ=WEEKLY;INTERVAL=2" },
  { label: "Every month", rrule: "FREQ=MONTHLY" },
];

/** Local-midnight ISO day key ("2026-07-16") — the heatmap's cell key. Local, not
 *  UTC: a run at 9pm on the 16th belongs to the 16th in the runner's timezone. */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface CadenceTally {
  /** Expected days that have at least one row — the days you kept. */
  kept: number;
  /** Expected days in the window (the denominator). */
  expected: number;
  /** The CURRENT run of consecutive expected days that were kept, counting back
   *  from the most recent expected day at or before `today`. Days that were
   *  never expected can't break a streak (a weekend doesn't end a weekday
   *  habit). Zero when the latest expected day was missed. */
  streak: number;
}

/**
 * Score the done-days against the expected-days. Counting only EXPECTED days is
 * the whole point: a "3-day streak" on a weekday habit must survive the weekend,
 * and a rest day must never read as a failure.
 */
export function tallyCadence(
  expected: Set<string>,
  counts: Record<string, number>,
  today: Date,
): CadenceTally {
  if (expected.size === 0) return { kept: 0, expected: 0, streak: 0 };
  const todayKey = isoDay(today);
  // Only expected days up to today can be judged — a Friday still ahead of us
  // is neither kept nor missed.
  const judged = [...expected].filter((d) => d <= todayKey).sort();
  const kept = judged.filter((d) => (counts[d] ?? 0) > 0).length;
  let streak = 0;
  for (let i = judged.length - 1; i >= 0; i--) {
    if ((counts[judged[i]!] ?? 0) > 0) streak++;
    else break;
  }
  return { kept, expected: judged.length, streak };
}
