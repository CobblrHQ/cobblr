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
import { usePlatformWeb } from "./context";

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
  const { cobbIcon: Cobb } = usePlatformWeb();
  if (count === 0) return null;
  return (
    /* ONE line, always, clear of the floating chat button, and the CLOSE never
       moves.
       On a phone this grew to nearly the full width and every label broke in
       half ("2 / selected", "Print / labels", "Ask / Cobb"), and the right end
       ran under the chat bubble in the corner.
       The scroll is on the MIDDLE only. Wrapping the whole bar in overflow-x
       put the X inside the scrolling region, so on a narrow screen the one
       control that gets you out could scroll off the edge. The count and the X
       are pinned; only the actions between them slide. */
    <div className="fixed bottom-20 sm:bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg whitespace-nowrap max-w-[calc(100vw-1.5rem)]">
      {/* Just the number on a phone. "2 selected" spends a third of the bar
          saying what the checkboxes above already showed you; the number beside
          the actions is unambiguous. */}
      <span className="shrink-0 text-sm font-medium text-content dark:text-mortar-100">
        {count}
        <span className="hidden sm:inline"> selected</span>
      </span>
      <span className="shrink-0 text-faint dark:text-slate-600">·</span>
      <div className="flex min-w-0 items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar">
        {actions}
        {onAskCobb && (
          <button
            type="button"
            onClick={onAskCobb}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            title="Put these in the chat, ready for your question"
          >
            {/* Cobb's own head, not a generic speech bubble: this is the one
                button in the app that hands your selection to HIM, and the head
                is how he is recognised everywhere else. Falls back to the
                bubble if a host has not supplied the mascot. */}
            {Cobb ? <Cobb size={14} /> : <MessageSquare size={12} />}
            Ask Cobb
          </button>
        )}
      </div>
      <button
        onClick={onClear}
        className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-100 transition p-1"
        title="Clear selection"
        aria-label="Clear selection"
      >
        <X size={14} />
      </button>
    </div>
  );
}
