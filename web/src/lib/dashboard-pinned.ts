// Which saved views the dashboard shows as cards.
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

/** Explicit pins win; a fresh workspace falls back to the first two shared
 *  views so the section is not empty before anyone has pinned anything. */
export function choosePinnedViews<T extends DashViewLite>(allViews: readonly T[]): T[] {
  const explicit = allViews.filter((v) => v.pinned);
  if (explicit.length > 0) return explicit.slice(0, 4);
  return allViews.filter((v) => v.owner_user_id === null).slice(0, 2);
}

/** The nav names ("spices", "inventory") whose table already has a view card
 *  on the dashboard - the set the "Also enabled" line must not repeat. */
export function navNamesWithViewCards(allViews: readonly DashViewLite[]): Set<string> {
  return new Set(
    choosePinnedViews(allViews)
      .map((v) => v.entity_kind.split(":")[0] ?? "")
      .filter(Boolean),
  );
}
