// How long a kept sandbox stays, chosen by the person, bounded by the product.
//
// A sandbox lives an hour. Keeping it makes it a trial on the same demo box,
// and the owner's rule for that trial is that it is short and chosen (#3254):
// "we don't want people to actually use it for real". So the lengths are a
// fixed set, a week, two weeks or a month, and there is no "forever" and no
// free number. The server refuses anything else; the web offers exactly these.
//
// Buildless subpath: no runtime import of a sibling.

export const TRIAL_LENGTHS = [7, 14, 30] as const;
export type TrialLengthDays = (typeof TRIAL_LENGTHS)[number];

/** What each length is called where a person picks it. */
export const TRIAL_LENGTH_LABELS: Readonly<Record<TrialLengthDays, string>> = {
  7: "A week",
  14: "Two weeks",
  30: "A month",
};

/** The one picked when nothing is: the middle, so neither end is the default. */
export const DEFAULT_TRIAL_LENGTH: TrialLengthDays = 14;

export function isTrialLength(days: unknown): days is TrialLengthDays {
  return (TRIAL_LENGTHS as readonly number[]).includes(days as number);
}
