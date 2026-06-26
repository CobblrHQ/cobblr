// Small inline error state for data-fetching pages — so a failed fetch shows
// a clear "couldn't load" with a Retry instead of silently rendering as the
// empty state ("No results"). (Audit 2026-06-26 follow-up #8.)
import { AlertCircle } from "lucide-react";

export function QueryError({ what = "this", onRetry }: { what?: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 text-sm text-ember-600 dark:text-ember-400 py-2">
      <AlertCircle size={15} />
      <span>Couldn't load {what}.</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="underline hover:no-underline">
          Retry
        </button>
      ) : null}
    </div>
  );
}
