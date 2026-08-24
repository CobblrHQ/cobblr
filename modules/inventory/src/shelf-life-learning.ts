// Learning how long something keeps, from what you did to it.
//
// Nobody knows the shelf life of a jar of pesto. But everybody knows what they
// did: they bought it, they opened it, and eventually they either finished it or
// threw it out. Three taps, each with a date, and the durations fall out.
//
// THE ASYMMETRY THAT MAKES THIS HONEST, and the thing most likely to be got
// wrong by a keen implementation:
//
//   "threw it out"  is an OBSERVATION of the shelf life. It went bad after n
//                   days, so n is roughly how long it keeps.
//   "finished it"   is only a LOWER BOUND. It lasted at least n days, and might
//                   have lasted twice that. You ate it; you did not test it.
//
// A model that averages the two learns "pesto keeps 6 days" from somebody who
// happens to eat pesto quickly, and then starts warning them about food that
// was never going to spoil. So finishes never raise a shelf life on their own -
// they can only ever say "at least this long", and the answer stays absent until
// something has actually gone off.
//
// Absent is a real answer here. The rest of the system already treats a missing
// shelf life as "do not date anything", which is exactly right for a jar nobody
// has ever thrown away.

/** What happened to one lot, start to finish. Recorded when the lot ends, so an
 *  item accumulates one of these per jar rather than per tap. */
export interface LifecycleObservation {
  /** ISO date it arrived. */
  received_on: string;
  /** ISO date it was opened, if it ever was. */
  opened_on?: string | null;
  /** ISO date it ended. */
  ended_on: string;
  /** How it ended. `used` is a lower bound; `spoiled` is an observation. */
  ended: "used" | "spoiled";
}

export interface ShelfLifeEstimate {
  /** Days from arrival, unopened. Null until something has actually spoiled. */
  shelf_life_days: number | null;
  /** Days from opening. Null until something has spoiled AFTER being opened. */
  shelf_life_opened_days: number | null;
  /** The longest it has ever survived and been eaten. Not a shelf life - a
   *  floor. Worth showing ("lasted at least 21 days") and never worth acting on. */
  at_least_days: number | null;
  /** How many USABLE spoils each figure rests on. One is an anecdote, and a
   *  same-day mark is not an observation at all (see below), so this is not
   *  simply the number of times somebody tapped "threw it out". */
  spoiled_observations: number;
  used_observations: number;
  /** Marks that arrived and ended on the same day, counted but never measured.
   *  Kept visible so "I marked four of these" and "it has learned nothing"
   *  can both be true without looking like a bug. */
  same_day_marks: number;
}

/** How many to keep. Enough to average out a bad jar, few enough that a habit
 *  from two years ago stops voting. */
export const MAX_OBSERVATIONS = 12;

const DAY = 86_400_000;

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const d = Math.round((b - a) / DAY);
  return d >= 0 ? d : null;
}

/**
 * A duration worth learning from.
 *
 * ZERO IS NOT A MEASUREMENT. Something recorded as arriving and being binned on
 * the same calendar day tells you when the record was written, not how long the
 * food keeps - and people do write records after the fact, especially right
 * after a scan, where the arrival date IS today by construction.
 *
 * Left in, two of those make a median of 0, which passes the confidence check
 * and is then APPLIED, so every future arrival of that item is stamped as
 * expiring the day it turns up. The item then screams from the moment it is
 * bought, and the person has no idea why - they only ever said "I threw this
 * one out".
 *
 * A punnet of berries that really was mouldy in the bag is the same shape and
 * the same answer: "it arrived bad" is a fact about that bag, not a shelf life.
 */
function usableDuration(n: number | null): n is number {
  return n !== null && n > 0;
}

/** Median, not mean: one jar forgotten at the back for three months should not
 *  drag the estimate for every other jar. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * What the history says, and what it deliberately does not say.
 */
export function estimateShelfLife(observations: LifecycleObservation[]): ShelfLifeEstimate {
  const spoiled = observations.filter((o) => o.ended === "spoiled");
  const used = observations.filter((o) => o.ended === "used");

  // Unopened shelf life: only from things that spoiled WITHOUT being opened.
  // A jar that was opened and then went off is telling us about the opened
  // clock, not the sealed one, and mixing them shortens the sealed figure for
  // everybody who opens things promptly.
  const sealedSpoils = spoiled
    .filter((o) => !o.opened_on)
    .map((o) => daysBetween(o.received_on, o.ended_on))
    .filter(usableDuration);

  // Opened shelf life: things that spoiled after being opened, measured from
  // the opening rather than from the purchase.
  const openedSpoils = spoiled
    .filter((o) => o.opened_on)
    .map((o) => daysBetween(o.opened_on!, o.ended_on))
    .filter(usableDuration);

  // The floor. Every observation contributes, spoils included: a jar that
  // spoiled at 20 days still survived 20 days.
  const survived = observations
    .map((o) => daysBetween(o.received_on, o.ended_on))
    .filter((n): n is number => n !== null);

  const sameDay = spoiled.filter((o) => daysBetween(o.received_on, o.ended_on) === 0).length;

  return {
    shelf_life_days: median(sealedSpoils),
    shelf_life_opened_days: median(openedSpoils),
    at_least_days: survived.length ? Math.max(...survived) : null,
    // Only spoils that actually measured something get a vote on confidence.
    // Counting same-day marks here is how two catch-up taps become a confident
    // shelf life of zero.
    spoiled_observations: sealedSpoils.length + openedSpoils.length,
    used_observations: used.length,
    same_day_marks: sameDay,
  };
}

/**
 * Is this worth acting on yet?
 *
 * One spoiled jar is an anecdote - it might have been left in a hot car. Two
 * agreeing is a pattern worth dating future arrivals from. Below that the
 * estimate is still worth SHOWING (so somebody can accept it), just not worth
 * applying by itself.
 */
export function isConfident(estimate: ShelfLifeEstimate): boolean {
  return estimate.spoiled_observations >= 2;
}

/** Add one, keeping the list bounded and in order. */
export function recordObservation(
  observations: LifecycleObservation[],
  next: LifecycleObservation,
): LifecycleObservation[] {
  const all = [...observations, next].sort((a, b) => a.ended_on.localeCompare(b.ended_on));
  return all.slice(-MAX_OBSERVATIONS);
}

/**
 * One line a person can read about what has been learned.
 *
 * Says the floor when there is no real figure, because "lasted at least 3 weeks
 * so far" is genuinely useful and "unknown" is not. Never states a shelf life
 * that rests on nothing having spoiled.
 */
export function describeEstimate(estimate: ShelfLifeEstimate): string {
  const parts: string[] = [];
  if (estimate.shelf_life_days !== null) {
    parts.push(`keeps about ${estimate.shelf_life_days} days unopened`);
  }
  if (estimate.shelf_life_opened_days !== null) {
    parts.push(`about ${estimate.shelf_life_opened_days} days once opened`);
  }
  if (parts.length === 0) {
    if (estimate.at_least_days !== null) {
      return `lasted at least ${estimate.at_least_days} days so far, and none has gone off yet`;
    }
    return "nothing learned yet";
  }
  const basis =
    estimate.spoiled_observations === 1
      ? " (from one that went off, so treat it lightly)"
      : ` (from ${estimate.spoiled_observations} that went off)`;
  return parts.join(", ") + basis;
}
