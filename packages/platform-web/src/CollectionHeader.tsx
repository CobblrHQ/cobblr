// The strip at the top of every collection: its name and count, then its
// filters, then the search and the actions on the right (#4014). One layout,
// so every control shares one height and one centre line, the name and the
// count share a baseline, the gaps are the same, and at a phone's width it
// wraps into rows that each still line up.
//
// The strip was written by hand on each collection page, every control at its
// own size: the name on a baseline row, a 22px mono count, a 20px "states"
// chip, a 28px segmented control, a 28px search, a 30px view toggle and a 38px
// button, none on one line (the owner's 3D Printers screenshot).
// e2e/collection-header-one-line.mjs checks the centre line at 1440 and 390.
import type { ReactNode } from "react";
import { PlaceOnPlan } from "./PlaceOnPlan";
import { ExportCsvButton } from "./ExportCsvButton";

/** The one height every control in the strip takes (36px), with its content
 *  centred. A custom control in `filters` or `actions` puts this on its own
 *  root; SearchInput, ViewModeToggle and HeaderButton already do. */
export const HEADER_CONTROL = "h-9 inline-flex items-center shrink-0";

/** A strip button: a secondary one (outlined) or the collection's primary
 *  (filled, the "+ New" at the end). */
export function headerButton(tone: "primary" | "secondary" = "secondary"): string {
  return `${HEADER_CONTROL} gap-1.5 rounded-md px-3 text-sm font-medium transition ${
    tone === "primary"
      ? "bg-slate-700 hover:bg-slate-600 text-mortar-50"
      : "border border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800"
  }`;
}

export function CollectionHeader({
  title,
  count,
  nav,
  filters,
  search,
  actions,
  hint,
  kind,
  exportCsv = true,
  exportQuery,
  below,
}: {
  title: ReactNode;
  /** "3 of 60": what the page shows of what there is. */
  count?: ReactNode;
  /** Tabs of the collection's own pages (its list, its settings). */
  nav?: ReactNode;
  /** Chips, segmented controls and selects that narrow the list. */
  filters?: ReactNode;
  search?: ReactNode;
  /** The view toggle, then the primary action last. */
  actions?: ReactNode;
  /** What goes in the collection, when its name does not say so on its own
   *  ("Supplies": markers, needles, safety eyes). The bundle's `hint`. */
  hint?: string | null;
  /** The collection's kind: a collection of physical things offers the floor
   *  plan's place mode under its name. */
  kind?: string;
  /** With a kind, the strip offers Export (the collection as a spreadsheet,
   *  read as the viewer). False only where the page offers its own. */
  exportCsv?: boolean;
  /** The search the list is showing, so the file is what is on screen. */
  exportQuery?: string;
  /** Anything else for the line under the strip. */
  below?: ReactNode;
}) {
  return (
    <div className="border-b border-line dark:border-slate-700 pb-3 space-y-1.5" data-collection-header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-baseline gap-x-2" data-header-title>
          <h1 className="font-display text-2xl font-extrabold leading-9 text-content dark:text-mortar-100 page-title">{title}</h1>
          {count != null && <span className="text-xs font-mono tabular-nums text-faint dark:text-slate-500">{count}</span>}
        </div>
        {nav && (
          <nav className="flex h-9 items-center gap-5 text-sm" data-header-controls>
            {nav}
          </nav>
        )}
        {filters && (
          <div className="flex flex-wrap items-center gap-2" data-header-controls>
            {filters}
          </div>
        )}
        {(search || actions || (kind && exportCsv)) && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2" data-header-controls>
            {search}
            {kind && exportCsv ? <ExportCsvButton kind={kind} q={exportQuery} /> : null}
            {actions}
          </div>
        )}
      </div>
      {(hint || kind || below) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {hint ? (
            <p className="text-xs text-muted dark:text-slate-400" data-testid="table-hint">
              {hint}
            </p>
          ) : null}
          {kind ? <PlaceOnPlan kind={kind} /> : null}
          {below}
        </div>
      )}
    </div>
  );
}
