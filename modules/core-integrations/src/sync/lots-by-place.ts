// A source that keeps one thing as several stock rows (Part-DB's lots) says
// where each row is and how many it holds. Cobblr keeps one card with a row
// per place (docs/design-decisions/holdings-and-units.md): this decides which
// place is the card's own row and which are the others. Pure.

export interface StockRow {
  id: string;
  /** The source's id of the place; null when the row has none. */
  place: string | null;
  qty: number;
}

export interface Placed {
  /** The card's own row: where the oldest placed row is, with everything held
   *  there plus the rows that have no place. */
  own: { place: string | null; qty: number };
  /** Every other place, keyed by its oldest row so a row that moves is the
   *  same record and a place that empties is the one that goes. */
  others: Array<{ id: string; place: string; qty: number; rows: string[] }>;
}

/** Source ids sort as numbers when they are numbers (2 before 10). */
const byId = (a: StockRow, b: StockRow): number => a.id.localeCompare(b.id, undefined, { numeric: true });

export function lotsByPlace(rows: readonly StockRow[]): Placed {
  const sorted = [...rows].sort(byId);
  const places = new Map<string, { id: string; place: string; qty: number; rows: string[] }>();
  let unplaced = 0;
  for (const r of sorted) {
    const qty = Number.isFinite(r.qty) ? Math.max(0, r.qty) : 0;
    if (r.place == null || r.place === "") {
      unplaced += qty;
      continue;
    }
    const g = places.get(r.place);
    if (g) {
      g.qty += qty;
      g.rows.push(r.id);
    } else places.set(r.place, { id: r.id, place: r.place, qty, rows: [r.id] });
  }
  const [first, ...rest] = [...places.values()];
  if (!first) return { own: { place: null, qty: unplaced }, others: [] };
  return { own: { place: first.place, qty: first.qty + unplaced }, others: rest };
}
