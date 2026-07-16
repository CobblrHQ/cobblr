// The rrule half of the cadence overlay, split out so it is DYNAMIC-IMPORTED.
//
// ViewsPage is eagerly imported by App, so anything it statically imports ships
// on first load for everyone. rrule is ~30KB gz and is needed only when a
// heatmap actually declares an expected cadence — a rare, opt-in case. So the
// renderer `import()`s this module on demand, exactly as the vite config
// prescribes for three.js and @zxing. Keep this file's surface tiny; the pure
// math lives in ./cadence.
//
// NOTE the import style: api/core-recurrence does `import rrulePkg from "rrule"`
// + destructure, because Node resolves rrule's CJS build and a named ESM import
// off it breaks there. The BROWSER build resolves rrule's ESM entry, where the
// default-import form fails to bundle instead ("rrulestr is not exported by").
// Same package, opposite import — don't "make them consistent" without building
// both.
import { rrulestr } from "rrule";
import { isoDay } from "./cadence";

export interface ExpectedDays {
  /** Day keys the cadence expects within the window. Empty when there is no
   *  cadence — the caller then draws the plain count grid. */
  days: Set<string>;
  /** True when a cadence was given but could not be parsed. The caller shows the
   *  grid WITHOUT an overlay and says so — a cadence we can't read must never be
   *  drawn as "you missed every day". */
  invalid: boolean;
}

/**
 * The days an RRULE expects between `from` and `to` (inclusive), as local day
 * keys. An empty/blank rrule yields no days and no error — "no expectation".
 *
 * The rule is anchored at `from` (DTSTART), so a bare `FREQ=WEEKLY` means "once
 * a week starting at the window's edge" rather than throwing for want of a
 * start. Never throws: a rule we can't parse comes back `invalid`, because the
 * overlay is an aid and a bad rule must not take the grid down with it.
 */
export function expandExpectedDays(rrule: string | undefined | null, from: Date, to: Date): ExpectedDays {
  const src = (rrule ?? "").trim();
  if (!src) return { days: new Set(), invalid: false };
  try {
    const rule = rrulestr(src, { dtstart: startOfDay(from) });
    const days = new Set<string>();
    for (const d of rule.between(startOfDay(from), endOfDay(to), true)) {
      days.add(isoDay(d));
    }
    return { days, invalid: false };
  } catch {
    return { days: new Set(), invalid: true };
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
