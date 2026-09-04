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
  /** Where the system thinks it goes - from where siblings live, or from how
   *  the thing has to be kept. A suggestion, not a decision: it is the LAST
   *  fallback below, under anything a person said. */
  suggested_location_id?: string | null;
  suggested_location_note?: string | null;
  /** Stamped server-side at match time. `tracked_match` is the entity this
   *  workspace ALREADY has that this scan is another of. */
  suggested_metadata?: Record<string, unknown> | null;
}

/** The entity a scan turned out to be another of. */
export interface TrackedMatchLike {
  kind: string;
  id: string;
  title: string;
  instance?: string | null;
}

/**
 * The thing this workspace already has, when the scan is another of it.
 *
 * Resolved server-side and stamped on the row, so the closed card and the bulk
 * sweep read the same answer rather than each deciding for themselves.
 */
export function trackedMatchOf(it: ScanItemLike): TrackedMatchLike | null {
  const m = it.suggested_metadata?.tracked_match as TrackedMatchLike | null | undefined;
  return m && m.kind && m.id && m.title ? m : null;
}

/**
 * "+N, more of the same" for an item the workspace already tracks.
 *
 * A second scan of a thing you already have is a re-purchase, not a new
 * record. Filing it as new is how one product becomes two rows that differ
 * only in word order - "Roma Tomatoes" and "Tomatoes Roma" - which nobody
 * should have to notice, least of all after the fact.
 *
 * Only for an item that is otherwise ready: this decides HOW to file, never
 * WHETHER.
 */
export function attachBodyFor(
  it: ScanItemLike,
): { kind: string; entity_id: string; instance?: string; mode: "add-qty" } | null {
  if (!isReadyToFile(it)) return null;
  const m = trackedMatchOf(it);
  if (!m) return null;
  return {
    kind: m.kind,
    entity_id: m.id,
    ...(m.instance ? { instance: m.instance } : {}),
    mode: "add-qty",
  };
}

/** What "File all" is about to merge rather than create, for the label that
 *  has to say so before it happens. Names are the EXISTING entities', because
 *  that is what the count will join. */
export function duplicateSummary(items: readonly ScanItemLike[]): { count: number; names: string[] } {
  const names = items
    .filter((it) => isReadyToFile(it))
    .map((it) => trackedMatchOf(it)?.title)
    .filter((t): t is string => !!t);
  return { count: names.length, names: [...new Set(names)] };
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
    //
    // Without the suggestion a shop of groceries filed with NO home at all: the
    // suggestion existed, the chip offered "Put here", and nobody presses that
    // thirty times, so every item landed nowhere and the storage check then
    // complained about spots it could have filled.
    //
    // ORDER, and the middle one is deliberate. A location set on the ITEM is a
    // decision about that item and wins outright. The batch location is a
    // default for the rest - "put these away in the kitchen" - so it must NOT
    // override a spot worked out for one item, or picking Kitchen for a shop
    // would send the frozen peas to the kitchen and then warn about them,
    // which is the whole complaint. What the batch answers for is everything
    // with no better idea.
    location_id: it.target_location_id ?? it.suggested_location_id ?? agreedLocationId ?? undefined,
  };
}

/** What "File all" is about to do with locations, for the confirm that asks.
 *
 *  A batch that silently placed things would be the same mistake as a batch
 *  that silently placed nothing: the person has to be able to SEE that six are
 *  going in the Fridge before it happens. Names are grouped and counted rather
 *  than listed per item - the point is the shape of the answer, not an
 *  inventory. */
export function placementPreview(
  items: readonly ScanItemLike[],
  agreedLocationId?: string | null,
): { placed: Array<{ name: string; count: number }>; unplaced: number } {
  const byName = new Map<string, number>();
  let unplaced = 0;
  for (const it of items) {
    if (!isReadyToFile(it)) continue;
    // Only the SUGGESTED spots are described. A location the person set on the
    // item is not news, and reporting it back as though the system had decided
    // it would be misleading.
    if (it.target_location_id) continue;
    const name = it.suggested_location_id ? (it.suggested_location_note?.split(" — ")[0] ?? "a suggested spot") : null;
    if (!name) {
      // Covered by the batch location, if one was picked; genuinely homeless
      // otherwise. Either way the system decided nothing, so it says nothing.
      if (!agreedLocationId) unplaced++;
      continue;
    }
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  return {
    placed: [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    unplaced,
  };
}
