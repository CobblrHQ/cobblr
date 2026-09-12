// A count cannot go below zero.
//
// `use-one` on a record at 0 wrote -1, and nothing said so (dev rig,
// 2026-09-12). Every decrementing path added its delta to the column: use-one,
// use-up, mark-spoiled, adjust-stock with a negative delta, the row's own
// stepper. Now that these run unconfirmed under Changes: auto, a model that
// miscounts could walk a count negative with no card in between.
//
// One rule, applied at the quantity write so every handler inherits it: a
// decrement on an empty record is REFUSED, and says so in the one sentence a
// chat card, a wire, a row button and a relay all get; a decrement larger than
// what is on hand is CLAMPED to zero and says how much it actually took. The
// database carries the same floor as a CHECK constraint (migration 0009), so
// a path that forgets this rule fails loudly instead of writing a minus.
// Pure, so it is a test.

/** The sentence every surface gets when there is nothing to take. */
export const NOTHING_ON_HAND = "Nothing on hand to use";
/** The sentence for an absolute count below zero. */
export const BELOW_ZERO = "A count cannot be below zero";

export type FloorVerdict =
  | { kind: "apply"; applied: number }
  | { kind: "clamp"; applied: number; note: string }
  | { kind: "refuse"; applied: 0; error: string };

/** What a delta may do to a count, given what is on hand. */
export function floorDelta(onHand: number, delta: number): FloorVerdict {
  const have = Number.isFinite(onHand) ? onHand : 0;
  if (!(delta < 0)) return { kind: "apply", applied: delta };
  if (have <= 0) return { kind: "refuse", applied: 0, error: NOTHING_ON_HAND };
  if (have + delta < 0) {
    return { kind: "clamp", applied: -have, note: `Only ${have} on hand; took ${have}, now 0` };
  }
  return { kind: "apply", applied: delta };
}
