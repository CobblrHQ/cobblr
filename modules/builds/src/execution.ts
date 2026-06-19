// Shop-floor execution rollups (rung 6) — pure functions over the append-only
// time + quantity logs. Kept DB-independent so they're unit-testable and shared
// by the detail route. "actual vs estimated" and "good / scrap / rework + yield"
// are the two numbers a shop actually watches per operation.

export interface OpTimeEntry {
  kind: string; // labor | machine | setup
  minutes: number;
}
export interface OpQtyEntry {
  kind: string; // good | scrap | rework
  quantity: number;
}

export interface OpRollup {
  actual_minutes: number;
  time_by_kind: { labor: number; machine: number; setup: number };
  good_qty: number;
  scrap_qty: number;
  rework_qty: number;
  /** good / (good + scrap), as a 0–100 percentage; null when nothing produced. */
  yield_pct: number | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function rollupOperation(times: OpTimeEntry[], qtys: OpQtyEntry[]): OpRollup {
  const time_by_kind = { labor: 0, machine: 0, setup: 0 };
  let actual_minutes = 0;
  for (const t of times) {
    const m = num(t.minutes);
    actual_minutes += m;
    if (t.kind === "labor" || t.kind === "machine" || t.kind === "setup") {
      time_by_kind[t.kind] += m;
    }
  }

  let good_qty = 0;
  let scrap_qty = 0;
  let rework_qty = 0;
  for (const q of qtys) {
    const n = num(q.quantity);
    if (q.kind === "good") good_qty += n;
    else if (q.kind === "scrap") scrap_qty += n;
    else if (q.kind === "rework") rework_qty += n;
  }

  const producedForYield = good_qty + scrap_qty;
  const yield_pct = producedForYield > 0 ? Math.round((good_qty / producedForYield) * 1000) / 10 : null;

  return { actual_minutes, time_by_kind, good_qty, scrap_qty, rework_qty, yield_pct };
}
