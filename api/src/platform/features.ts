// Which features this site offers (#4737 follow-up).
//
// A normal feature is on unless the operator names it in COBBLR_FEATURES_OFF.
// An experimental feature is OFF on every site, self-hosted ones included,
// unless the operator names it in COBBLR_FEATURES_ON: it is not ready, so a
// fresh install never shows it. A new experiment is one line in the list
// below; making it ready is taking that line out.

/** Experiments: hidden everywhere unless COBBLR_FEATURES_ON names them. */
export const EXPERIMENTAL_FEATURES: readonly string[] = [
  "suggestions.tidy", // nightly tidy-up suggestions
];

const listed = (raw: string | undefined, name: string): boolean =>
  (raw || "")
    .split(",")
    .map((s) => s.trim())
    .includes(name);

/** Is this feature off on this site? Turned off by the operator, or an
 *  experiment the operator has not turned on. */
export function featureOff(name: string): boolean {
  if (listed(process.env.COBBLR_FEATURES_OFF, name)) return true;
  return EXPERIMENTAL_FEATURES.includes(name) && !listed(process.env.COBBLR_FEATURES_ON, name);
}
