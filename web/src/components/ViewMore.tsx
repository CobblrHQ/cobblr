// The line under a view that does not hold every record yet: how many are
// showing, of how many, and the rest on a press. Renders nothing for a whole
// view, so a surface can place it unconditionally.
import type { ViewData } from "../lib/useViewData";

export function ViewMore({ data }: { data: ViewData }) {
  if (data.complete || data.items.length === 0) return null;
  return (
    <div data-testid="view-more" className="flex items-center justify-center gap-3 py-2 text-xs text-muted dark:text-slate-400">
      <span>
        Showing {data.items.length}
        {data.total !== null ? ` of ${data.total}` : ""}
      </span>
      {data.loadMore && (
        <button
          type="button"
          onClick={data.loadMore}
          disabled={data.loadingMore}
          className="rounded border border-line dark:border-slate-700 px-2 py-1 text-content dark:text-mortar-100 hover:border-accent disabled:opacity-50"
        >
          {data.loadingMore ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
