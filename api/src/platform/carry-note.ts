// The words a carried trial's bundle line ends with (carry-replay.ts). Pure,
// so the rule is pinned by its own test with the versions it compares.

/** What the carry says of a catalog bundle: always the version installed
 *  now, and the trial's own when it differs. A kept trial's bundles may have
 *  been brought up to date before it is carried (keeping it ends the sandbox,
 *  and the hourly bundle-update sweep then reaches it), so the trial's version
 *  can be the current one, and then there is nothing older to name. */
export function bundleCarryNote(now: string, trialVersion: string): string {
  return now && trialVersion && now !== trialVersion
    ? `the current version, ${now}; your trial had ${trialVersion}`
    : `the current version${now ? `, ${now}` : ""}`;
}
