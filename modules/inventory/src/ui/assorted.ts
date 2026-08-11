// Is this row's number an ESTIMATE rather than a count?
//
// The signal is the PRESENCE of approximate_qty — the same test the detail
// card and the entity resolver use, so a list row, a tile and the card never
// disagree about whether a record is an assortment.
//
// This exists because a list is where the original complaint bites hardest: a
// bin holding roughly fifty adapters renders `qty 0`, and a person scanning
// the page reads that as an empty bin. See
// docs/design-decisions/assorted-contents.md.

export interface AssortedLike {
  qty?: number | string | null;
  approximate_qty?: number | string | null;
}

export function isAssorted(p: AssortedLike | null | undefined): boolean {
  return p?.approximate_qty != null;
}

/** What a qty cell reads for an assortment. Never a bare number: the tilde is
 *  the whole point, and a `0` with no mark is the lie this feature fixes. */
export function assortedQty(p: AssortedLike): string {
  const n = Number(p.approximate_qty ?? 0);
  return `~${Number.isFinite(n) ? n : 0}`;
}
