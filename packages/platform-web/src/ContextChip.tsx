// The chip above a message box that says what the next message is about.
//
// Ask Cobb and Discussion each drew their own, so they could drift apart in
// wording, size and what × did. One component: the same chip in both boxes,
// and × always means "not about this any more".

import { X } from "lucide-react";

export function ContextChip({
  label,
  detail,
  title,
  onRemove,
}: {
  /** What a person calls it: "Rack 1", "12 parts". */
  label: string;
  /** Extra words shown after the label, when they add something. */
  detail?: string;
  title?: string;
  /** × drops it. Without this the chip cannot be removed. */
  onRemove?: () => void;
}) {
  return (
    <div className="flex" data-testid="context-chip">
      <div className="inline-flex items-center gap-1.5 rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900 px-2 py-1 text-[11px] text-cobble-800 dark:text-cobble-100 max-w-full">
        {/* Not "In context": that is the vocabulary of the tool, not of the
            person using it. What the chip means is "my next message is about
            this". */}
        <span className="shrink-0 opacity-70">About:</span>
        <span className="truncate font-medium" title={title ?? label}>
          {label}
          {detail ? ` — “${detail}”` : ""}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 opacity-60 hover:opacity-100"
            title="Remove: don't include this"
            aria-label="Remove from context"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
