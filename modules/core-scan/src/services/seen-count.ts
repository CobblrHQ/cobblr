// How many of a thing a model says it SAW in one photo. One rule, read by
// every identify path.
//
// This is deliberately not the filed-quantity rule (filed-quantity.ts). What
// a model claims it saw is a different assertion from what a person files:
// a photo shows a handful of things, a label on one of them states a pack,
// and a person filing stock states what they hold. So the floor is the same
// (a thing seen is at least one) and the ceiling is not: a seen count has
// at most three digits, enough for any pack a label states and short of the
// four-and-five-digit numbers a model mistakes for a count (a capacity, a
// weight, a part number). A person may still file more (up to
// FILED_QUANTITY_MAX) by saying so at the stepper.
//
// Three readers of the model's answer each wrote this bound from memory and
// two of them forgot the ceiling, so the same answer was cut at one door and
// accepted at another (#3098). This is the one copy.

export const SEEN_COUNT_MIN = 1;
export const SEEN_COUNT_MAX = 999;

/** How many DIFFERENT things one photo can be said to show. Two digits: a
 *  shelf, not a warehouse. */
export const SEEN_DISTINCT_MAX = 99;

/** The rule as a clamp, for a value the model answered (there is no one to
 *  refuse it to): the nearest count that obeys it. Missing, blank or
 *  unreadable is one. */
export function seenCountOf(value: unknown): number {
  return clampSeen(value, SEEN_COUNT_MIN, SEEN_COUNT_MAX);
}

/** The distinct count, by the same shape. */
export function seenDistinctOf(value: unknown): number {
  return clampSeen(value, 1, SEEN_DISTINCT_MAX);
}

function clampSeen(value: unknown, min: number, max: number): number {
  if (value === null || value === undefined || value === "") return min;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min) return min;
  return Math.min(n, max);
}
