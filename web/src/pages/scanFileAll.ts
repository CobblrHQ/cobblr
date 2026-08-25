// Pure routing behind the scan session-header "File all" button (and the
// selection bulk-confirm). Kept out of the component so the one load-bearing
// detail — WHICH destination each item commits to — is unit-tested.
//
// The bug this guards against (2026-07-16): a workspace scanned ~40 books, and
// they never reached its "Bookshelf" instance. Two mistakes stranded them:
//   1. the session header showed a passive "All set" check that only collapsed
//      the row on click, so the user filed nothing and thought they had; and
//   2. the bulk path passed the candidate's INSTANCE-scoped kind
//      ("bookshelf:item") as target_kind → the confirm endpoint built
//      kindKey "assets:bookshelf:item", which isn't a scannable → 400.
// The confirm endpoint's target_kind is the module's BASE kind; the instance is
// carried separately. Dropping the instance (or sending the wrong kind) sends
// an item to the module's default table instead of the chosen instance.

export interface ScanCandidateLike {
  module: string;
  /** The candidate's own kind label — may be instance-scoped ("bookshelf:item").
   *  NOT what the confirm endpoint wants for target_kind (that's the base kind). */
  kind?: string;
  instance?: string | null;
  fields?: Record<string, unknown>;
  quantity?: number | null;
  /** The grouping-axis value the matchmaker resolved (folded into `fields`). */
  category?: string;
  /** How a non-AI candidate earned its route (see ScanCandidate.basis). */
  basis?: "noun" | "keywords" | "fallback";
}
export interface ScanItemLike {
  id: string;
  status: string;
  suggested_name?: string | null;
  suggested_candidates?: ScanCandidateLike[] | null;
  quantity?: number | null;
  target_location_id?: string | null;
}

/** The confirm endpoint's target_kind is the module's BASE kind (the instance,
 *  when present, scopes the create separately). */
export function baseKind(module: string): string {
  return module === "assets" ? "asset" : module === "machines" ? "machine" : "part";
}

/** A pending item is "ready to file" when it has a name AND a confident
 *  destination (a top candidate). Items still needing a manual look are
 *  excluded so "File all" never guesses; resolved items are already filed.
 *
 *  A keyword-basis route is NOT confident: it is a no-AI guess held up only by
 *  corroborating keyword hits — the tier that once filed a storage tote into
 *  Vehicles because a marketing description grazed "car(ds)"/"mak(ing)e". The
 *  card renders those tentative, and File all must match what the card offers:
 *  a route the card won't one-tap is not one a bulk sweep may commit. Noun and
 *  fallback bases stay filable (a no-AI workspace still files cleanly). */
export function isReadyToFile(it: ScanItemLike): boolean {
  const top = it.suggested_candidates?.[0];
  return it.status === "pending" && !!it.suggested_name && !!top && top.basis !== "keywords";
}

/** Ids of the items "File all" will commit, in order. */
export function readyToFileIds(items: readonly ScanItemLike[]): string[] {
  return items.filter(isReadyToFile).map((it) => it.id);
}

export interface ConfirmBody {
  target_module: string;
  target_kind: string;
  instance?: string;
  name: string;
  quantity?: number;
  extras?: Record<string, unknown>;
  location_id?: string;
}

/** The confirm body that routes an item to ITS top candidate — module + BASE
 *  kind + the instance the matchmaker chose. Returns null when the item isn't
 *  ready (no name / no candidate / already resolved). */
/** What installing a bundle actually produced, as the install reports it.
 *
 *  A candidate's `instance` is not always a real instance. A bundle that
 *  PROVIDES one (Bookshelf) names it; a bundle that SKINS the module default
 *  (Groceries) has none, and the routing menu still needs a token to tell that
 *  bundle apart, so it carries a synthetic one - the bundle's own slug. The two
 *  are indistinguishable from the candidate alone.
 *
 *  Install answers the question: it reports the target it really created, with
 *  a null instance for the skinning case. Pass that here and it wins. */
export interface InstalledBundleTarget {
  instance: string | null;
}

export function confirmBodyFor(
  it: ScanItemLike,
  /** The category the whole session agreed on. Overrides ONLY the axis field, so
   *  a batch scanned together lands in one section instead of two spellings of
   *  the same word. Omitted -> the item files under its own. */
  agreedCategory?: string | null,
  /** A place chosen for the whole batch. Filing needs a category AND somewhere
   *  to put the thing; without this an item commits with no home and is findable
   *  only by search. The item's own location still wins when it has one. */
  agreedLocationId?: string | null,
  /** The real target of the bundle this item routes to, from its install. When
   *  given it REPLACES the candidate's instance, including replacing it with
   *  nothing. Only the instance: a multi-target bundle reports its primary
   *  target here, so the module and kind stay with the candidate, which knows
   *  which of them this item is for. */
  installedTarget?: InstalledBundleTarget | null,
  /** The name of the table's DECLARED category axis (field_role: "category",
   *  via categoryAxisKey and the scan menu). The value-guess below is the
   *  drift sessionCategory was written to end - a row whose stored value
   *  differs from the candidate's category matches nothing, so the agreed
   *  category silently failed to apply on exactly the rows that needed it.
   *  Optional so a caller with no menu degrades to the guess, not to nothing. */
  categoryAxis?: string | null,
): ConfirmBody | null {
  const cand = it.suggested_candidates?.[0];
  if (!isReadyToFile(it) || !cand) return null;
  const fields = { ...(cand.fields ?? {}) };
  if (agreedCategory) {
    const axis =
      (categoryAxis && categoryAxis in fields ? categoryAxis : null) ??
      (cand.category ? Object.keys(fields).find((k) => fields[k] === cand.category) : undefined);
    if (axis) fields[axis] = agreedCategory;
  }
  return {
    target_module: cand.module,
    target_kind: baseKind(cand.module),
    instance: (installedTarget ? installedTarget.instance : cand.instance) ?? undefined,
    name: it.suggested_name!,
    quantity: it.quantity ?? cand.quantity ?? undefined,
    extras: fields,
    // The confirm endpoint never defaults to target_location_id — carry a
    // pre-set home (active-bin filing, an organize apply) or it's dropped.
    location_id: it.target_location_id ?? agreedLocationId ?? undefined,
  };
}
