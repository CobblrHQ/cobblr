// The chrome of the item SHEET: a scan inbox item as its own screen on a
// phone (and the gallery's focus at every width). The card inside is the
// same InboxCard the list renders; this file is only what pins around it:
// the header (the way out at the far left, where you are in the queue, the
// way to the next one) and the footer (the one commit door, and once the
// form is open the screen's Cancel with the form's Confirm beside it, Discard
// as the secondary). Pinned, so a long item never needs a scroll back up to
// leave (#2982).
//
// Cancel in the footer is the SCREEN's: it leaves, the same as the header's
// "All items". It used to be the form's own cancel, portaled in, which only
// closed the form; a review row has no one-tap Add, so the footer collapsed
// to Discard alone and the person stood on a screen with nothing to press
// (#3018). The form's cancel is not a screen-level control on a phone.
//
// Both are sticky INSIDE the modal's scroller, hence sticky-in-scroller /
// sticky bottom-0 and never a top-* of their own (lint:sticky-under-header).
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, PackagePlus, Trash2 } from "lucide-react";

/** The shape of a footer ACTION: the one commit door, "+1 more", the form's
 *  Add portalled into the slot. It never shrinks below its words: it may
 *  take the whole row, and past that its label wraps inside it. A primary
 *  that was allowed to shrink (min-w-0 beside a max-w percentage) and not
 *  to wrap overflowed its own box whenever the row ran short (larger text,
 *  a long table name): WebKit centres a button's overflowing content, so
 *  the icon slid over Cancel and the label ran off the screen. */
export const SHEET_ACTION_CLASS =
  "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-4 py-2.5 text-left text-sm font-semibold text-white transition";

/** An action's icon and words: the icon keeps its size, the words wrap. */
export function SheetActionLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <>
      {icon ? <span className="inline-flex shrink-0">{icon}</span> : null}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </>
  );
}

export interface ScanItemSheetNav {
  index: number;
  total: number;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
}

export function ScanItemSheetHeader({ nav }: { nav: ScanItemSheetNav }) {
  const arrow =
    "inline-flex items-center justify-center min-h-11 min-w-11 rounded-lg border border-line dark:border-slate-700 text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition disabled:opacity-30";
  return (
    <div className="sticky-in-scroller z-20 flex items-center gap-1 border-b border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5">
      <button
        type="button"
        onClick={nav.onClose}
        className="inline-flex items-center gap-0.5 rounded-md px-2 py-2 text-sm font-medium text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
      >
        <ChevronLeft size={18} className="-ml-1" />
        All items
      </button>
      <span className="flex-1 text-center text-xs tabular-nums text-muted dark:text-slate-400">
        {nav.index + 1} of {nav.total}
      </span>
      <button type="button" onClick={() => nav.onPrev?.()} disabled={!nav.onPrev} aria-label="Previous item" className={arrow}>
        <ChevronLeft size={18} />
      </button>
      <button type="button" onClick={() => nav.onNext?.()} disabled={!nav.onNext} aria-label="Next item" className={arrow}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

export function ScanItemSheetFooter({
  formOpen,
  addLabel,
  onOpenForm,
  primary,
  onCancel,
  onDiscard,
  discardPending,
  setActionSlot,
}: {
  /** The confirm form is open: its Confirm portals into the slot, beside
   *  the screen's own Cancel. */
  formOpen: boolean;
  /** "Add to Groceries…" or "Add to a table…". */
  addLabel: string;
  onOpenForm: () => void;
  /** The row's resolved action when it is not the form's own filing (a
   *  "+1 more" onto a record the workspace counts): rendered in the slot's
   *  place with the same words the list and the session show, so the
   *  screen never offers a create where the row says merge (#3076). The
   *  form's Confirm then renders inside the form, as filing it as new. */
  primary?: { label: string; title?: string; busy: boolean; onClick: () => void } | null;
  /** Leave the screen without changes (the header's "All items"). */
  onCancel: () => void;
  onDiscard: () => void;
  discardPending: boolean;
  /** Where ConfirmForm renders its Confirm (see its actionSlot). */
  setActionSlot: (el: HTMLDivElement | null) => void;
}) {
  return (
    // Discard and Cancel never shrink and never wrap (the owner's phone
    // showed "ncel" and "el", #3068). The ROW wraps: when the three do not
    // fit, the primary moves to a line of its own rather than squeezing, and
    // on that line its words wrap inside it. So no width, text size or label
    // can push an action off the screen or over its neighbour
    // (e2e/sheet-footer-never-clips.mjs walks every state).
    <div data-testid="sheet-footer" className="sticky bottom-0 z-20 flex flex-wrap items-center justify-end gap-2 border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]">
      <button
        type="button"
        onClick={onDiscard}
        disabled={discardPending}
        className="mr-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-2 text-sm text-ember-600 dark:text-ember-400 hover:bg-ember-50 dark:hover:bg-ember-900/20 transition disabled:opacity-50"
        title="Discard (recoverable from Recently deleted)"
      >
        <Trash2 size={14} /> Discard
      </button>
      {!formOpen && (
        <button
          type="button"
          onClick={onOpenForm}
          className={`${SHEET_ACTION_CLASS} bg-cobble-600 hover:bg-cobble-700`}
        >
          <SheetActionLabel>{addLabel}</SheetActionLabel>
        </button>
      )}
      {formOpen && (
        <>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-2.5 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 transition"
          >
            Cancel
          </button>
          {primary ? (
            <button
              type="button"
              onClick={primary.onClick}
              disabled={primary.busy}
              title={primary.title}
              data-testid="sheet-primary"
              className={`${SHEET_ACTION_CLASS} bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60`}
            >
              <SheetActionLabel icon={<PackagePlus size={14} className={primary.busy ? "animate-pulse" : ""} />}>{primary.label}</SheetActionLabel>
            </button>
          ) : (
            <div ref={setActionSlot} className="flex min-w-0 max-w-full justify-end" />
          )}
        </>
      )}
    </div>
  );
}
