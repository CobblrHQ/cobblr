import { fieldCurrency, roundMoneyAmount } from "@cobblr/platform-contract/money";

export const REFUND_ALREADY_RECORDED = "A refund was already recorded. The saved amount has been kept.";

export type RefundLine = {
  qty: string | number;
  unit_cost: string | number | null;
  line_amount?: string | number | null;
  metadata?: unknown;
};

export function suggestedPurchaseRefund(line: RefundLine, qty: number, currency: string): number | null {
  if (fieldCurrency(line.metadata, "unit_cost", currency) !== currency) return null;
  const bought = Number(line.qty);
  if (line.line_amount != null) {
    if (bought <= 0) return null;
    return roundMoneyAmount(Number(line.line_amount) * (qty / bought), currency);
  }
  return line.unit_cost == null ? null : roundMoneyAmount(Number(line.unit_cost) * qty, currency);
}
