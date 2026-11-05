/** What a group of typed captures can offer in one press. The server leaves a
 *  row it doubts out of a bulk action, so a button counting it offered "Add all 4"
 *  and filed none (#9224). A row on its own files whatever the doubt says, through
 *  its own Add, so a group of one keeps its button and one left of many needs none. */
export function captureAddAll<T extends { bulk_doubt?: string | null }>(captures: readonly T[]): { offer: T[] | null; left: T[] } {
  if (captures.length === 1) return { offer: [...captures], left: [] };
  const offer = captures.filter((c) => !c.bulk_doubt);
  return { offer: offer.length > 1 ? offer : null, left: captures.filter((c) => !!c.bulk_doubt) };
}
