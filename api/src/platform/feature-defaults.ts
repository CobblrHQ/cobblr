// Which optional features an install ends up with.
//
// `default: true` is a FIRST-INSTALL concept. It means "most people setting this
// up for the first time want this", and the person is looking at the checkbox
// when they press the button.
//
// An update is a different situation with the same word in it. Nobody is asked
// anything, and a feature the author marked default in a NEW version has never
// been in front of the person at all. Falling back to the new manifest's
// defaults there silently opts them into something they never saw.
//
// THAT IS NOT HYPOTHETICAL. Groceries 0.4.0 was installed with no features on.
// The 0.6.0 update added `kitchen-places` with `default: true`, and the update
// enabled it and created Fridge, Freezer and Pantry inside a Kitchen that was
// already there and already arranged. The modal that ran the update said, in
// so many words, "an update never adds or removes capabilities."
//
// So: an explicit set is always honoured, because that is a person choosing. The
// FALLBACK is what changes. On an update the fallback is what is already
// installed; a default can only ever turn something on the first time.

/** A feature as the manifest declares it. Only what the decision needs. */
export interface FeatureDecl {
  key: string;
  default?: boolean;
}

export interface ResolveFeaturesInput {
  /** Features declared by the version being installed. */
  declared: FeatureDecl[];
  /** What the caller explicitly asked for, if anything. `[]` is an explicit
   *  answer meaning "none of them" and must not be confused with "unspecified". */
  requested?: string[] | undefined;
  /** What is on right now, or null when nothing is installed (a first install). */
  installed?: string[] | null;
}

/**
 * The feature set to install, and which of them the person has never been asked
 * about.
 *
 * `newToYou` is not used to enable anything. It exists so the surface running
 * the update can say "this version adds X - want it?" instead of either
 * enabling it quietly or never mentioning it.
 */
export function resolveEnabledFeatures(input: ResolveFeaturesInput): {
  enabled: string[];
  newToYou: string[];
} {
  const declaredKeys = new Set(input.declared.map((f) => f.key));
  const isUpdate = input.installed !== null && input.installed !== undefined;

  // A key that is no longer declared is dropped either way: keeping it would
  // leave the install carrying a feature the manifest can no longer describe.
  const keep = (keys: string[]): string[] => keys.filter((k) => declaredKeys.has(k));

  if (input.requested !== undefined) {
    // A person answered. Even an empty answer is an answer.
    return { enabled: keep([...new Set(input.requested)]), newToYou: [] };
  }

  if (!isUpdate) {
    // First install: defaults are what they are for, and the checkboxes were
    // on screen.
    return {
      enabled: input.declared.filter((f) => f.default).map((f) => f.key),
      newToYou: [],
    };
  }

  const already = new Set(keep(input.installed ?? []));
  // Anything declared that is not already on has never been agreed to. Note
  // this deliberately covers a feature that existed before and was declined:
  // re-offering is fine, re-enabling is not.
  const newToYou = input.declared.filter((f) => !already.has(f.key)).map((f) => f.key);
  return { enabled: [...already], newToYou };
}

/**
 * Features this version adds that the person has never seen, worth asking about.
 *
 * Separate from the resolve so a preview can show it before anything is written.
 */
export function featuresToOffer(
  declared: FeatureDecl[],
  installed: string[] | null | undefined,
  priorDeclared?: FeatureDecl[] | null,
): FeatureDecl[] {
  if (installed === null || installed === undefined) return [];
  const on = new Set(installed);
  // When we know what the PREVIOUS version declared, "new" means new to the
  // bundle, not merely "off". A feature somebody deliberately declined is not
  // news and should not be re-asked on every update.
  const priorKeys = priorDeclared ? new Set(priorDeclared.map((f) => f.key)) : null;
  return declared.filter((f) => !on.has(f.key) && (priorKeys === null || !priorKeys.has(f.key)));
}
