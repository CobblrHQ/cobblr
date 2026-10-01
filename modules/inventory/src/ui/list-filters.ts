// Which of the list's filters to offer: the ones this table's records can
// answer, and any a person has already set.
//
// The bar used to offer all eight to everybody, so an empty shop at phone
// width opened on warranty and insured before a single item. A filter over a
// field nothing fills narrows nothing; it is a question with no answer. The
// records say which apply (GET parts/facets). A filter already set is always
// offered, whatever the records say, so nobody is left narrowed with no way
// to see or clear why.

export interface PartFacets {
  total: number;
  category: boolean;
  location: boolean;
  state: boolean;
  lifecycle: boolean;
  low_stock: boolean;
  archived: boolean;
  warranty: boolean;
  insured: boolean;
}

export const LIST_FILTERS = ["category", "location", "state", "lifecycle", "low_stock", "archived", "warranty", "insured"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

/** The filters to draw. Unknown facets (still loading, or the call failed)
 *  offer only what is already set. */
export function offeredFilters(facets: PartFacets | undefined, active: ReadonlySet<ListFilter>): ListFilter[] {
  return LIST_FILTERS.filter((f) => active.has(f) || !!facets?.[f]);
}

/** Nothing to filter: no records, none archived, nothing set. The bar is not
 *  drawn at all then; the empty state is the page. */
export function nothingToFilter(facets: PartFacets | undefined, active: ReadonlySet<ListFilter>, searching: boolean): boolean {
  return !!facets && facets.total === 0 && !facets.archived && active.size === 0 && !searching;
}
