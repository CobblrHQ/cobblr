// A lent thing says so where it is listed: "With Sam Lee", and "Overdue" once
// its due day has passed. The loan is read from the record's own metadata, by
// the same readers as its page (record-loans.md), so a list row and the page
// cannot disagree about whether it is out.
import { HandHelping } from "lucide-react";
import { dayHere } from "@cobblr/platform-contract/day";
import { loanOverdue, readRecordLoan } from "@cobblr/platform-contract/loan";

export function LentChip({ metadata }: { metadata: unknown }) {
  const loan = readRecordLoan(metadata);
  if (!loan) return null;
  const late = loanOverdue(loan, dayHere(new Date()));
  return (
    <span
      data-testid="lent-chip"
      title={late ? `Overdue: ${loan.holder} has it` : `${loan.holder} has it`}
      className={`inline-flex items-center gap-1 whitespace-nowrap text-[10px] ${late ? "font-medium text-ember-700 dark:text-ember-300" : "text-muted dark:text-slate-400"}`}
    >
      <HandHelping size={11} aria-hidden className="shrink-0" />
      {late ? "Overdue · " : ""}With {loan.holder}
    </span>
  );
}
