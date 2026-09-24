// How full a consumable is: the ONE reading every surface uses (the detail
// page's Consumption panel and its gauge, a list, the assistant).
//
// A gauge divides two quantities, and they must be in the same unit. A new
// yarn with 2 skeins and a Length / skein of 200 m read "2 skein left · of
// 200 skein · 1%": the count, in skeins, divided by the length of ONE skein,
// in metres, with the metres labelled skeins (#3648). So every number here
// travels with its unit (`Amount`), and a percentage is only ever taken
// between two amounts in one unit, directly or converted through the
// workspace's unit vocabulary. When neither is possible there is no
// percentage, never a wrong one.
//
// The three shapes a consumable's capacity comes in:
//   same unit      a spool counted in grams with a 1000 g capacity: 800 of 1000 g, 80%
//   convertible    counted in kg with a capacity in g: converted, then divided
//   per unit       counted in skeins (or any count) with a capacity that is a
//                  measure of ONE of them (200 m a skein): every counted unit
//                  is a whole one, so the gauge reads one unit, full; an opened
//                  one is tracked on its own, in metres. Never a total across
//                  units: "400 m over two balls" is not a thing you can knit
//                  with (consumption-ledger.md §0).
// Conversion is not done here. The vocabulary is handed in (`UnitLens`), so the
// factors stay in core-units, where lint:unit-conversion keeps them.

/** A number that knows what it counts. */
export interface Amount {
  readonly value: number;
  readonly unit: string | null;
}

/** The workspace's unit vocabulary, as a gauge needs it. */
export interface UnitLens {
  /** The unit's code in the vocabulary; null for free text ("skein"). */
  code(raw: string | null): string | null;
  /** True for a measured unit (mass, length, volume): one with a factor. */
  isMeasure(raw: string | null): boolean;
  /** `value` from one unit to another in the same category, else null. */
  convert(value: number, from: string | null, to: string | null): number | null;
}

export interface ConsumptionGauge {
  left: Amount;
  full: Amount;
  /** 0-100, rounded and clamped. */
  pct: number;
  /** The capacity is a measure of ONE counted unit (a skein's metres), and
   *  `left`/`full` are one unit's worth: "200 m each". */
  perUnit: boolean;
}

const norm = (u: string | null | undefined): string | null => {
  const t = (u ?? "").trim();
  return t ? t : null;
};

function sameUnit(a: string | null, b: string | null, lens: UnitLens): boolean {
  if (a === null || b === null) return a === b;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const ca = lens.code(a);
  return ca !== null && ca === lens.code(b);
}

/** What fraction of `full` `left` is, as 0-100, when the two are in one unit
 *  or convert to one; null otherwise. */
export function amountPct(left: Amount, full: Amount, lens: UnitLens): number | null {
  if (!Number.isFinite(left.value) || !Number.isFinite(full.value)) return null;
  let fullValue: number | null = null;
  if (sameUnit(norm(left.unit), norm(full.unit), lens)) fullValue = full.value;
  else fullValue = lens.convert(full.value, norm(full.unit), norm(left.unit));
  if (fullValue === null || fullValue <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((left.value / fullValue) * 100)));
}

/**
 * The gauge for an item counted as `qty` `unit` with a `capacity` in
 * `capacityUnit` (null: the capacity is in the count's own unit, the typed
 * "full amount" of a flat consumable). Null when there is no capacity, or no
 * honest way to put the two in one unit.
 */
export function consumptionGauge(
  item: { qty: number; unit: string | null; capacity: number | null; capacityUnit: string | null },
  lens: UnitLens,
): ConsumptionGauge | null {
  const { qty, capacity } = item;
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(qty)) return null;
  const countUnit = norm(item.unit);
  const capUnit = norm(item.capacityUnit);
  const left: Amount = { value: qty, unit: countUnit };

  // Same unit, or no unit of its own: the capacity is the full amount.
  if (capUnit === null || sameUnit(capUnit, countUnit, lens)) {
    const full: Amount = { value: capacity, unit: countUnit };
    const pct = amountPct(left, full, lens);
    return pct === null ? null : { left, full, pct, perUnit: false };
  }
  // Convertible: put the capacity in the count's unit, then divide.
  const converted = lens.convert(capacity, capUnit, countUnit);
  if (converted !== null) {
    const full: Amount = { value: converted, unit: countUnit };
    const pct = amountPct(left, full, lens);
    return pct === null ? null : { left, full, pct, perUnit: false };
  }
  // A count of things with a measure of one of them: every counted unit is a
  // whole one, so each reads full, and the figure is one unit's, never a sum.
  if (lens.isMeasure(capUnit) && !lens.isMeasure(countUnit)) {
    const one: Amount = { value: capacity, unit: capUnit };
    return { left: qty > 0 ? one : { value: 0, unit: capUnit }, full: one, pct: qty > 0 ? 100 : 0, perUnit: true };
  }
  // Two measures in different categories (grams against metres): no honest %.
  return null;
}

/** What is left of an item, as every surface reports it: the unopened count,
 *  each open unit's remainder, and, only when all of it is in one measure,
 *  the total. The assistant read a Yarn's capacity (200 m, ONE skein) as what
 *  was left while the page said 160 m (#3651): a record now carries this, so
 *  no reader works it out from the fields itself. */
export interface Remaining {
  unopened: Amount;
  open: Amount[];
  /** What is left when that is ONE amount: a plain count or measure, or the
   *  single open unit with nothing unopened (160 m). Null otherwise: metres
   *  are never added up across units (consumption-ledger.md §0), so the parts
   *  stand on their own. */
  total: Amount | null;
  /** The same, in words: "160 m left in 1 open, none unopened (200 m each)". */
  text: string;
}

export function remainingOf(
  item: { qty: number; unit: string | null; capacity: number | null; capacityUnit: string | null; open?: readonly Amount[] },
  lens: UnitLens,
): Remaining {
  const countUnit = norm(item.unit);
  const qty = Number.isFinite(item.qty) ? Math.max(0, item.qty) : 0;
  const open = (item.open ?? []).filter((a) => Number.isFinite(a.value) && a.value > 0);
  const capUnit = norm(item.capacityUnit);
  const unopened: Amount = { value: qty, unit: countUnit };
  const fmt = (a: Amount) => `${+a.value.toFixed(3)}${a.unit ? ` ${a.unit}` : ""}`;
  const perUnitMeasure =
    item.capacity != null && item.capacity > 0 && capUnit !== null && lens.isMeasure(capUnit) && !lens.isMeasure(countUnit);

  let total: Amount | null = null;
  if (open.length === 0 && !perUnitMeasure) total = unopened;
  else if (open.length === 1 && qty === 0) total = open[0]!;

  const each = perUnitMeasure ? ` (${fmt({ value: item.capacity!, unit: capUnit })} each)` : "";
  const unopenedWords = qty > 0 ? `${fmt(unopened)} unopened` : "none unopened";
  let text: string;
  if (open.length === 0) text = perUnitMeasure ? `${unopenedWords}${each}` : `${fmt(unopened)} left`;
  else if (total) text = `${fmt(total)} left in 1 open, ${unopenedWords}${each}`;
  else text = `${open.length} open with ${open.map(fmt).join(" + ")}, ${unopenedWords}${each}`;
  return { unopened, open, total, text };
}

/** A lens that knows no units: only two amounts in literally the same unit
 *  compare. For a reader holding two numbers it already knows share one. */
export const SAME_UNIT_ONLY: UnitLens = {
  code: () => null,
  isMeasure: () => false,
  convert: () => null,
};
