// Which saved views the dashboard shows as cards.
//
// In the contract (#6563): the server names the pinned views' reads in the
// dashboard snapshot by the same rule the page draws them by.
//
// Extracted so the ONE rule has one home: the "your views" section renders
// these, and the at-a-glance "Also enabled" line must skip tables that already
// have one of these cards on screen - a line saying "spices - nothing in them
// yet" fifteen pixels above a Spices card saying "no items here yet" is the
// same fact twice, and twice is how a dashboard turns into furniture. Two
// copies of this choice would drift, and the drift would be invisible: both
// halves render fine alone.

export interface DashViewLite {
  entity_kind: string;
  pinned?: boolean | null;
  owner_user_id?: string | null;
}

/** How many pinned views Home shows as cards. A bundle pinning more loses the
 *  rest from Home without a word, so lint:bundle-quality holds bundles to it. */
export const HOME_PINNED_VIEW_CAP = 4;

/** Explicit pins win; a fresh workspace falls back to the first two shared
 *  views so the section is not empty before anyone has pinned anything. */
export function choosePinnedViews<T extends DashViewLite>(allViews: readonly T[], folded: ReadonlySet<string> = new Set()): T[] {
  // A table folded into a family page (Filament Types and Spools are one
  // Filament page with its own views) has no view cards of its own: they
  // would put the two tables back side by side on the dashboard.
  const views = allViews.filter((v) => !folded.has(v.entity_kind.split(":")[0] ?? ""));
  const explicit = views.filter((v) => v.pinned);
  if (explicit.length > 0) return explicit.slice(0, HOME_PINNED_VIEW_CAP);
  return views.filter((v) => v.owner_user_id === null).slice(0, 2);
}

/** The nav names ("spices", "inventory") whose table already has a view card
 *  on the dashboard - the set the "Also enabled" line must not repeat. */
export function navNamesWithViewCards(allViews: readonly DashViewLite[], folded: ReadonlySet<string> = new Set()): Set<string> {
  return new Set(
    choosePinnedViews(allViews, folded)
      .map((v) => v.entity_kind.split(":")[0] ?? "")
      .filter(Boolean),
  );
}
