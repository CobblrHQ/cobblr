// Price-history math — "what have I paid for this thing, and is it going up?"
//
// Pure so it unit-tests without a DB (tests/price-stats.test.ts). The route
// (api/items.ts) does the SQL; this does the arithmetic, so a rounding or
// direction bug is caught by a fast test rather than by a chart that looks
// plausible.
//
// A point with no unit_cost (a line someone never priced) still counts as a
// purchase but is excluded from every price figure — averaging a null as zero
// would report a phantom price drop.

/** One purchase of one thing: a line item, flattened with its order's date. */
export interface PricePoint {
  id: string;
  order_id: string;
  order_number: string | null;
  vendor: string | null;
  /** ISO date the money was spent — the line's received_at, else the order's
   *  arrived_at / ordered_at. Null when nothing on either row carries a date. */
  purchased_at: string | null;
  description: string | null;
  qty: number;
  unit_cost: number | null;
}

export interface PriceStats {
  /** Purchases in the window, priced or not. */
  purchases: number;
  /** Purchases that carry a unit_cost — the denominator of every figure below. */
  priced: number;
  latest: number | null;
  previous: number | null;
  /** latest − previous. Null until there are two priced purchases. */
  change_abs: number | null;
  change_pct: number | null;
  direction: "up" | "down" | "flat" | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  first_purchased_at: string | null;
  last_purchased_at: string | null;
  /** Σ qty × unit_cost over priced purchases. */
  total_spent: number | null;
}

const EMPTY: PriceStats = {
  purchases: 0,
  priced: 0,
  latest: null,
  previous: null,
  change_abs: null,
  change_pct: null,
  direction: null,
  min: null,
  max: null,
  avg: null,
  first_purchased_at: null,
  last_purchased_at: null,
  total_spent: null,
};

/** Money to cents. Chained float sums drift (0.1+0.2), and a price chart that
 *  reads $4.300000000000001 reads as broken. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Sort oldest → newest. Undated points sort FIRST (they're history of unknown
 *  age, so they must never be read as "the latest price"). Ties keep input
 *  order, which the route hands over already tie-broken by created_at. */
export function sortByPurchasedAt(points: PricePoint[]): PricePoint[] {
  return points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const ad = a.p.purchased_at;
      const bd = b.p.purchased_at;
      if (ad === bd || (!ad && !bd)) return a.i - b.i;
      if (!ad) return -1;
      if (!bd) return 1;
      return ad < bd ? -1 : 1;
    })
    .map(({ p }) => p);
}

/** Summarize a part's purchase history. `points` may arrive in any order. */
export function summarizePriceHistory(points: PricePoint[]): PriceStats {
  if (points.length === 0) return { ...EMPTY };
  const ordered = sortByPurchasedAt(points);
  const priced = ordered.filter(
    (p): p is PricePoint & { unit_cost: number } =>
      typeof p.unit_cost === "number" && Number.isFinite(p.unit_cost),
  );
  const dated = ordered.filter((p) => p.purchased_at);

  const base: PriceStats = {
    ...EMPTY,
    purchases: ordered.length,
    priced: priced.length,
    first_purchased_at: dated[0]?.purchased_at ?? null,
    last_purchased_at: dated[dated.length - 1]?.purchased_at ?? null,
  };
  if (priced.length === 0) return base;

  const costs = priced.map((p) => p.unit_cost);
  const latest = costs[costs.length - 1]!;
  const previous = costs.length > 1 ? costs[costs.length - 2]! : null;
  const changeAbs = previous === null ? null : round2(latest - previous);
  // A previous price of 0 (a freebie, a fully-discounted line) has no
  // meaningful percentage — every increase from it is infinite. Report the
  // absolute change and leave the percentage null rather than emit Infinity.
  const changePct =
    previous === null || previous === 0
      ? null
      : Math.round(((latest - previous) / previous) * 1000) / 10;

  return {
    ...base,
    latest: round2(latest),
    previous: previous === null ? null : round2(previous),
    change_abs: changeAbs,
    change_pct: changePct,
    direction: changeAbs === null ? null : changeAbs > 0 ? "up" : changeAbs < 0 ? "down" : "flat",
    min: round2(Math.min(...costs)),
    max: round2(Math.max(...costs)),
    avg: round2(costs.reduce((s, c) => s + c, 0) / costs.length),
    total_spent: round2(priced.reduce((s, p) => s + p.unit_cost * (Number.isFinite(p.qty) ? p.qty : 1), 0)),
  };
}
