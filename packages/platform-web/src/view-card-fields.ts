// Which of a saved view's declared fields a phone card shows, and in what
// order. A view IS its fields: "Insurance valuation" declares replacement
// value, purchase date and condition, and on a phone its cards showed only a
// name and a location, so the one screen meant for reading valuations could
// not show one (#3626). The desktop table already takes the view's columns;
// the card now takes the same list, in the view's own order: the first few on
// the card, the rest one tap away. Every card renderer for a saved view reads
// it here, so a phone and a desktop never disagree about what a view shows.

/** How many declared fields a card shows before "More". */
export const CARD_FIELDS_ON_CARD = 3;

export interface ViewCardFields<T> {
  onCard: T[];
  more: T[];
}

/**
 * `declared` is the view's visible_fields; `defs` the fields the card can draw
 * (a workspace's custom fields for the table), matched by `nameOf`. Names the
 * card already carries on its own (the title, the location line) are in
 * `alreadyShown` and are skipped. With no declared list there is nothing
 * view-specific to show.
 */
export function viewCardFields<T>(
  declared: readonly string[] | null | undefined,
  defs: readonly T[],
  nameOf: (d: T) => string,
  alreadyShown: ReadonlySet<string> = new Set(),
  onCard = CARD_FIELDS_ON_CARD,
): ViewCardFields<T> {
  if (!declared || declared.length === 0) return { onCard: [], more: [] };
  const byName = new Map(defs.map((d) => [nameOf(d), d] as const));
  const ordered: T[] = [];
  for (const name of declared) {
    if (alreadyShown.has(name)) continue;
    const d = byName.get(name);
    if (d && !ordered.includes(d)) ordered.push(d);
  }
  return { onCard: ordered.slice(0, onCard), more: ordered.slice(onCard) };
}
