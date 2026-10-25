// The three figures on a purchase line (how many, each, line total) come from
// one place, so the number beside the price is the number the total was made
// from. The quantity was printed with toFixed(0): a line of 1.5 at $4 read
// "2 × $4" beside "$6" (#7828).

import { formatQuantity } from "@cobblr/platform-web";

export interface LineFigures {
  /** "1.5 × $4": the count as stored (up to three decimals), then the price each. */
  each: string;
  /** The line total, or null when the line has no price. */
  total: number | null;
}

export function lineAmount(line: { qty: string | number; unit_cost: string | number | null; line_amount?: string | number | null }): number | null {
  return line.line_amount != null ? Number(line.line_amount) : line.unit_cost != null ? Number(line.qty) * Number(line.unit_cost) : null;
}

export function lineFigures(qty: number, unitCost: number | null, money: (v: number) => string | null, statedAmount: number | null = null): LineFigures {
  return {
    each: `${formatQuantity(qty, null, [])} × ${unitCost != null ? money(unitCost) ?? "—" : "—"}`,
    total: lineAmount({ qty, unit_cost: unitCost, line_amount: statedAmount }),
  };
}
