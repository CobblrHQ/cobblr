// Every value a proposed create or update will write, under the card's line
// (#3658). A value the person's words did not give says so, and any value
// that is not required can be taken off before Confirm.

import { X } from "lucide-react";
import type { ProposalValue } from "../lib/proposal-values";

export function ProposalValues({ values, onRemove }: { values: ProposalValue[]; onRemove: (field: string) => void }) {
  if (!values.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-xs text-content dark:text-mortar-100" data-testid="proposal-values">
      {values.map((v) => (
        <li key={v.field} className="flex items-baseline gap-1.5">
          <span className="text-faint">{v.label}:</span>
          {v.from !== undefined ? (
            <span>
              <span className="text-muted line-through decoration-1">{v.from}</span> → <span className="font-medium">{v.value}</span>
            </span>
          ) : (
            <span className="font-medium">{v.value}</span>
          )}
          {v.suggested && <span className="rounded bg-amber-50 dark:bg-amber-950/40 px-1 text-[10px] text-amber-800 dark:text-amber-300">suggested by Cobb</span>}
          {v.removable && (
            <button
              type="button"
              onClick={() => onRemove(v.field)}
              aria-label={`Leave out ${v.label}`}
              title={`Leave out ${v.label}`}
              className="ml-auto text-faint hover:text-content dark:hover:text-mortar-100"
            >
              <X size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
