// What an action said after it ran, beside the button that ran it.
//
// Two lines, from useInvokeEntityAction: `note`, a passing remark ("Printed
// to the shelf printer"), and `failure`, the action's own reason it did not
// happen, kept until dismissed. A flash of "err" that resets is not an
// answer (#2847: the item page's Print label flashed ERR twice over "no label
// base URL is set ... set one under Configuration", which nobody could read).
// Every surface that mounts the hook mounts this; lint:action-outcome-shown
// holds that.
import { X } from "lucide-react";

export function ActionOutcome({
  note,
  failure,
  onDismiss,
  className,
}: {
  note: string | null;
  failure: string | null;
  onDismiss: () => void;
  className?: string;
}) {
  if (!note && !failure) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 self-center text-[11px] ${className ?? ""}`}>
      {note && <span className="text-muted dark:text-slate-400">{note}</span>}
      {failure && (
        <span
          role="alert"
          data-testid="action-failure"
          className="inline-flex items-center gap-1 rounded border border-ember-200 bg-ember-50 px-1.5 py-0.5 text-ember-700 dark:border-ember-800 dark:bg-ember-900/30 dark:text-ember-300"
        >
          <span>{failure}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDismiss();
            }}
            className="rounded p-0.5 hover:bg-ember-100 dark:hover:bg-ember-900/60"
          >
            <X size={10} />
          </button>
        </span>
      )}
    </span>
  );
}
