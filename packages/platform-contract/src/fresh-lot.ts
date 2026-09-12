// When arriving stock is a fresh lot, and how long it is good for.
//
// Two modules need the same answer: the one that files the stock (its lots
// and the record's dates) and the one whose gesture causes it (the shopping
// row, which says beforehand what checking a line off will do). One rule,
// imported by both, so the row never promises a date the record will not get.
//
// The signal is data, never words: a wire says `restock: true` when its delta
// is stock that arrived (a wire's reason is free text and the next bundle
// phrases it differently), and anything arriving on an EMPTY record is the
// stock now, with dates of its own.

/** Does a positive delta start a lot dated today? */
export function startsFreshLot(input: { delta: number; qtyBefore: number; restock: boolean }): boolean {
  if (!(input.delta > 0)) return false;
  return input.restock || input.qtyBefore <= 0;
}

/** Today plus however long this keeps, as YYYY-MM-DD. Null when the item
 *  declares no shelf life, so nothing is invented. */
export function goodUntil(receivedOn: string, shelfLifeDays: number | null | undefined): string | null {
  if (shelfLifeDays == null || !Number.isFinite(shelfLifeDays) || shelfLifeDays <= 0) return null;
  const d = new Date(`${receivedOn}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.trunc(shelfLifeDays));
  return d.toISOString().slice(0, 10);
}
