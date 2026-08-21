// Sticky bottom bar for a list page's multi-select.
//
// Two things learned the hard way live here.
//
// It rendered NOTHING until a row was ticked, which hid the feature behind an
// unlabelled checkbox. The fix attempted first — an idle strip reading "Tick
// rows to print labels or delete" — replaced a hidden feature with a permanent
// piece of furniture on an empty page, which is worse: it is on screen always
// and useful once. The bar stays silent again; discoverability belongs to the
// checkbox column, not to a line of standing text.
//
// And ticking rows used to hand the selection to the assistant as a side
// effect, so printing labels for two racks silently made them the subject of
// your next message and lit their Cobb buttons. A checkbox and the Cobb button
// are different instructions: "do this to these" versus "let us talk about
// this". Cobb is one of the ACTIONS here now, so pointing him at a selection is
// something you ask for.

import type { ReactNode } from "react";
import { MessageSquare, X } from "lucide-react";

interface Props {
  count: number;
  /** Action buttons to render between the count and the dismiss
   *  button. Each consumer page decides what actions make sense
   *  (delete / tag / move / etc.). */
  actions: ReactNode;
  onClear: () => void;
  /** Hand the ticked rows to Cobb. Null when the page has not wired it (or
   *  nothing is ticked); the button is simply absent. */
  onAskCobb?: (() => void) | null;
}

export function BulkActionBar({ count, actions, onClear, onAskCobb }: Props) {
  if (count === 0) return null;
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg">
      <span className="text-sm font-medium text-content dark:text-mortar-100">
        {count} selected
      </span>
      <span className="text-faint dark:text-slate-600">·</span>
      <div className="flex items-center gap-2">
        {actions}
        {onAskCobb && (
          <button
            type="button"
            onClick={onAskCobb}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            title="Put these in the chat, ready for your question"
          >
            <MessageSquare size={12} />
            Ask Cobb
          </button>
        )}
      </div>
      <button
        onClick={onClear}
        className="text-faint hover:text-content dark:hover:text-mortar-100 transition p-1"
        title="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  );
}
