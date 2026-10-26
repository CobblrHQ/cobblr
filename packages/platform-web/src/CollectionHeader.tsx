import { useFlowHost, useViewerRole } from "./context";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { Link } from "react-router-dom";
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
import { useId, type ReactNode } from "react";
import { PlaceOnPlan } from "./PlaceOnPlan";
import { CollectionShare } from "./CollectionShare";
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
  selectedIds,
  selectionList,
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
  selectedIds?: readonly string[];
  selectionList?: string;
  exportCsv?: boolean;
  /** The search the list is showing, so the file is what is on screen. */
  exportQuery?: string;
  /** Anything else for the line under the strip. */
  below?: ReactNode;
}) {
  const titleId = useId();
  const { openFlow } = useFlowHost();
  const role = useViewerRole();
  return (
    <div className="border-b border-line dark:border-slate-700 pb-3 space-y-1.5" data-collection-header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* On a phone the name has the row to itself and the controls wrap
            under it: beside a select and a search it was squeezed, and the
            controls ran past the edge (#4390). */}
        <div className="flex flex-wrap gap-y-1 min-w-0 items-baseline gap-x-2 max-sm:basis-full" data-header-title>
          <h1 id={titleId} className="font-display text-2xl font-extrabold leading-9 text-content dark:text-mortar-100 page-title">{title}</h1>
          {/* Room for "22 of 22" from the start: "0 of 0" growing to it moved the
              controls after the title 14 px along (#7788). */}
          {count != null && <span className="inline-block min-w-[4.5rem] text-xs font-mono tabular-nums text-faint dark:text-slate-500">{count}</span>}
        </div>
        {/* Wraps, its gap in px: held on one line, a link shrank below its
            words and ran 28 px past a phone at 200% text (#8430). */}
        {nav && (
          <nav aria-labelledby={titleId} className="flex min-h-9 flex-wrap items-center gap-x-[20px] text-sm" data-header-controls>
            {nav}
          </nav>
        )}
        {filters && (
          <div className="flex flex-wrap items-center gap-2" data-header-controls>
            {filters}
          </div>
        )}
        {(search || actions || kind) && (
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 max-sm:w-full" data-header-controls>
            {search}
            {kind && ["owner", "admin", "member"].includes(role ?? "") && <button type="button" className={headerButton()} onClick={() => openFlow("core-views:group-table", { kind })}>Group by</button>}
            {kind && exportCsv ? <ExportCsvButton kind={kind} q={exportQuery} /> : null}
            {kind && roleSatisfies(role, ["owner", "admin"]) ? <CollectionShare kind={kind} title={title} ids={selectedIds} selectionList={selectionList} /> : null}
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
          {kind ? <Link className="text-xs text-muted underline" to={`/configuration/recently-deleted?kind=${encodeURIComponent(kind)}`}>Recently deleted</Link> : null}
          {below}
          {/* Last: it shows once the collection's faces answer, and arriving
              ahead of Recently deleted pushed that link 155 px along under a
              finger (#7781). At the end of the line it moves nothing. */}
          {kind ? <PlaceOnPlan kind={kind} /> : null}
        </div>
      )}
    </div>
  );
}
