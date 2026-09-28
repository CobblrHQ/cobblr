// "Still good": the person looked at it, it is fine, ask again in a few days.
//
// The date moves from the LATER of its own date and today. A tub of yoghurt
// 36 days past its date that somebody checked is good from today, not from 36
// days ago: pushing the old date by three would leave it 33 days overdue and
// the warning exactly where it was. Only the oldest dated lot moves, because
// that is the one the warning names; the others keep their own dates.

import { batchesFrom, reconcileToQty, sortBatches, visibleFrom } from "./batches.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `day` plus `days`, as a calendar day. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The later of the two days, then `days` on. */
export function stillGoodUntil(date: string, today: string, days: number): string {
  return addDays(date > today ? date : today, days);
}

/** The metadata patch that marks a record still good for `days` more days,
 *  or null when it carries no date to move. `expiryField` is the field the
 *  collection declares as its expiry (a bundle's "Best before"): the date
 *  every reminder reads, so it moves with the lots, or on its own when the
 *  record has no lots. */
export function stillGoodPatch(
  md: Record<string, unknown>,
  qty: number,
  today: string,
  days: number,
  expiryField: string | null = null,
): Record<string, unknown> | null {
  const dayOf = (v: unknown) => (typeof v === "string" && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
  const withField = (patch: Record<string, unknown>) =>
    expiryField && expiryField !== "expires_on" && patch.expires_on ? { ...patch, [expiryField]: patch.expires_on } : patch;
  const expiresOn = dayOf(md.expires_on) ?? (expiryField ? dayOf(md[expiryField]) : null);
  const lots = reconcileToQty(batchesFrom(md, qty, expiresOn), qty);
  const i = lots.findIndex((b) => b.qty > 0 && !!b.expires_on);
  if (i >= 0) {
    const moved = lots.map((b, j) => (j === i ? { ...b, expires_on: stillGoodUntil(b.expires_on, today, days) } : b));
    const next = sortBatches(moved);
    return withField({ batches: next, expires_on: visibleFrom(next).expires_on });
  }
  if (expiresOn) return withField({ expires_on: stillGoodUntil(expiresOn, today, days) });
  return null;
}
