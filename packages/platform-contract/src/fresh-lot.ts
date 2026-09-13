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

/** How long the item keeps, in whole days, from whatever its shelf-life
 *  field holds. A number field typed on a form can arrive as the string
 *  "10", and a reader that checks `typeof === "number"` then dates no lot
 *  while the shopping row beside it, coercing, promises one (2026-09-13:
 *  milk restocked from the list kept last week's use-by, because the lot
 *  the check-off started had no date to give). One reader, so the promise
 *  and the write read the field the same way. Null when the item declares
 *  no shelf life, or something that is not a positive number. */
export function shelfLifeDaysOf(value: unknown): number | null {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/** Today plus however long this keeps, as YYYY-MM-DD. Null when the item
 *  declares no shelf life, so nothing is invented. */
export function goodUntil(receivedOn: string, shelfLife: unknown): string | null {
  const shelfLifeDays = shelfLifeDaysOf(shelfLife);
  if (shelfLifeDays === null) return null;
  const d = new Date(`${receivedOn}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.trunc(shelfLifeDays));
  return d.toISOString().slice(0, 10);
}
