// Food does not go bad at midnight.
//
// The vending wall flipped a tile red the moment `expires_on` passed, and the
// sweeper called the same fact "expired". Both treated a best-before date as a
// cliff, which it is not: the date is the producer's promise, and most food is
// fine for a while past it. A wall of red over food that is still good teaches
// the person to ignore the wall - the cry-wolf cost, same as a false OVERDUE.
//
// `grace_days` is the item's own answer to "how long past the date is still
// fine" - a bundle field a person can set per item, and one the shelf-life
// learner can eventually fill. This is the ONE place its meaning lives, so the
// vending dot and the sweeper's event cannot drift apart on what "spoiled"
// means.

export type ExpiryState =
  /** No deadline pressure yet. */
  | "fresh"
  /** The date is close (within the warn window). Use it soon. */
  | "expiring"
  /** The date has passed but the item's own grace says it is still fine.
   *  "Use it now", not "throw it out". */
  | "past_date"
  /** Past the date AND past the grace. The honest word is spoiled. */
  | "spoiled";

export interface ExpiryReading {
  state: ExpiryState;
  /** Whole days until the date; negative once past. */
  daysUntil: number;
  /** Days past the date (0 while not yet past). */
  daysPast: number;
  /** Days of grace remaining once past the date (0 otherwise/after). */
  graceLeft: number;
}

/** How close counts as "expiring". Matches the vending wall's long-standing
 *  two-day amber window. */
export const EXPIRING_WITHIN_DAYS = 2;

const DAY = 86_400_000;

/**
 * Read one item's expiry, honouring its grace.
 *
 * `graceDays` that is missing, negative or nonsense reads as 0 - which is
 * exactly the old behaviour, so an item that never set the field changes
 * nothing.
 */
export function expiryState(
  expiresOn: string | Date | null | undefined,
  graceDays: unknown,
  now: Date = new Date(),
): ExpiryReading | null {
  if (expiresOn === null || expiresOn === undefined || expiresOn === "") return null;
  const ts = expiresOn instanceof Date ? expiresOn.getTime() : Date.parse(String(expiresOn));
  if (Number.isNaN(ts)) return null;
  // Number.isFinite, not truthiness: Infinity survives `|| 0` and would make
  // food immortal.
  const gn = Number(graceDays);
  const g = Number.isFinite(gn) ? Math.max(0, Math.trunc(gn)) : 0;
  const daysUntil = Math.ceil((ts - now.getTime()) / DAY);
  const daysPast = daysUntil < 0 ? -daysUntil : 0;
  const graceLeft = daysPast > 0 ? Math.max(0, g - daysPast) : 0;
  const state: ExpiryState =
    daysPast === 0
      ? daysUntil <= EXPIRING_WITHIN_DAYS
        ? "expiring"
        : "fresh"
      : daysPast <= g
        ? "past_date"
        : "spoiled";
  return { state, daysUntil, daysPast, graceLeft };
}

/** The words for a tile or a morning digest line. One writer, so the dot and
 *  the sentence can never disagree. */
export function expiryPhrase(r: ExpiryReading): string {
  switch (r.state) {
    case "fresh":
      return `expires in ${r.daysUntil}d`;
    case "expiring":
      return r.daysUntil === 0 ? "expires today" : `expires in ${r.daysUntil}d`;
    case "past_date":
      return `${r.daysPast}d past its date · still OK ~${r.graceLeft}d`;
    case "spoiled":
      return `expired ${r.daysPast}d ago`;
  }
}
