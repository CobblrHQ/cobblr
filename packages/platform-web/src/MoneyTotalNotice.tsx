import { moneyTotalNote, type MoneyTotal } from "@cobblr/platform-contract/money";
export function MoneyTotalNotice({ total }: { total?: Pick<MoneyTotal, "excluded" | "conversions"> | null }) {
  if (!total) return null;
  const omitted = Object.entries(total.excluded).map(([c, n]) => `excludes ${n} ${n === 1 ? "item" : "items"} in ${c}`).join("; ");
  const note = moneyTotalNote(total);
  if (!note) return null;
  return <span className="block text-xs text-muted" title={note} data-testid="money-rate-note">{omitted || "Converted at purchase-date rates"}</span>;
}
