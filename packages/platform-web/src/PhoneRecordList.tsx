// A list of records as stacked rows, for a phone.
//
// THE BUG THIS EXISTS FOR (#6340, 2026-10-13, the owner's own iPhone): every
// record page drew its list view as a wide <table> inside a sideways scroller.
// Scrolled left it showed a thumbnail and the name and nothing else; scrolled
// right it showed family, type, manufacturer and state with the name gone, and
// State was cut off mid-word at the screen edge ("REBUIL", "FUNCTI"). Rows two
// or three lines tall held ten to a screen. A table is the wrong shape for
// 390 px: the name and the state are the two facts a row is for, and they
// never fit side by side.
//
// So below the `sm` breakpoint a list view stops being a table. Each record is
// one stacked row: a small picture, the name, the state in full as a badge on
// the right, and one line under the name with what identifies it (family and
// make) and two or three of the view's own columns. Tiles are a separate view
// and are untouched. A page hands over plain data per row; the layout lives
// here once, so the next list gets the phone layout by calling it.

import { SelectBox } from "./SelectBox";
import { useSyncExternalStore, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

const PHONE = "(max-width: 639.98px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const q = window.matchMedia(PHONE);
  q.addEventListener?.("change", onChange);
  return () => q.removeEventListener?.("change", onChange);
}

const now = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;

/** True below the `sm` breakpoint, and follows a rotation or a resize. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, now, () => false);
}

export interface PhoneRecordRow {
  id: string;
  name: string;
  /** The page's own picture, already sized for a row (40 px). */
  picture?: ReactNode;
  /** The record's state, in full. Never clipped: it is a badge that does not shrink. */
  state?: string | null;
  /** What identifies it, in order: family, type, make. Joined with a dot. */
  identity?: Array<string | null | undefined>;
  /** The view's own columns, in the view's order. The first few show; the rest live in the record. */
  fields?: Array<{ label: string; value: string | null | undefined }>;
  /** How many of it the record stands for; shown as ×N when more than one. */
  quantity?: number | null;
  /** Anything small that belongs beside the state (a live status chip). */
  aside?: ReactNode;
  /** A control of its own (a count stepper), beside the row's button, never inside it. */
  trailing?: ReactNode;
}

export interface PhoneRecordListProps {
  rows: PhoneRecordRow[];
  onOpen: (id: string) => void;
  /** Present in select mode only. */
  selection?: { selected: Set<string>; onToggle: (id: string, checked: boolean) => void; onSelectAll?: (checked: boolean) => void };
  /** How many of the view's columns show under the name. */
  maxFields?: number;
  /** Names the list for assistive tech and for a test to find. */
  label?: string;
}

const present = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

export function PhoneRecordList({ rows, onOpen, selection, maxFields = 3, label = "List" }: PhoneRecordListProps) {
  return (
    <ul
      aria-label={label}
      data-testid="phone-record-list"
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 divide-y divide-line dark:divide-slate-700 overflow-hidden"
    >
      {selection?.onSelectAll && rows.length > 0 && (
        <li className="flex items-center gap-2.5 bg-subtle/60 dark:bg-slate-800/40 px-3 py-1.5">
          <SelectBox checked={rows.every((r) => selection.selected.has(r.id))} onChange={(checked) => selection.onSelectAll!(checked)} label="Select all" className="gap-2.5 text-[10px] uppercase tracking-widest text-muted dark:text-slate-400">
            Select all
          </SelectBox>
        </li>
      )}
      {rows.map((r) => {
        const identity = (r.identity ?? []).filter(present).join(" · ");
        const fields = (r.fields ?? []).filter((f) => present(f.value)).slice(0, maxFields);
        const under = [identity, ...fields.map((f) => `${f.label} ${f.value}`)].filter(present).join(" · ");
        return (
          // A row may wrap, and its button asks for 9rem (a basis: a phone
          // gives every button a min-width that beats ours). A count stepper
          // still sits beside the name on a 375 px phone, ticking box and all;
          // one too wide for that ("- 1 ingredient +", a unit other than
          // "each") goes under the name, where it once left the name two
          // letters wide (#6951).
          <li key={r.id} data-testid="phone-record-row" data-record-id={r.id} className="flex flex-wrap items-center">
            {selection && (
              <SelectBox checked={selection.selected.has(r.id)} onChange={(checked) => selection.onToggle(r.id, checked)} label={`Select ${r.name}`} className="ml-3" />
            )}
            <button
              type="button"
              onClick={() => onOpen(r.id)}
              className="min-w-0 grow basis-36 flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-subtle dark:hover:bg-slate-800/40 transition"
            >
              {r.picture && <span className="shrink-0">{r.picture}</span>}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  {/* Up to four lines (PHONE_RECORD_NAME_LINES; the row's height bound, PHONE_RECORD_ROW_MAX_PX, is every spec's), not an ellipsis: "CubePro #1 (Modded)" and "CubePro #2 (Stock)" must not read alike, and Safari sets a long name wider than Chrome does, so three cut "Custom CoreXY with the enclosed chamber and dual extruder" short. */}
                  <span data-testid="phone-record-name" className="min-w-0 flex-1 line-clamp-4 break-words text-sm font-medium leading-snug text-content dark:text-mortar-100">
                    {r.name}
                  </span>
                  {r.quantity != null && r.quantity > 1 && (
                    <span className="shrink-0 font-mono text-[11px] text-muted dark:text-slate-400">×{r.quantity}</span>
                  )}
                </span>
                {under && (
                  <span data-testid="phone-record-under" className="block truncate text-xs text-muted dark:text-slate-400">
                    {under}
                  </span>
                )}
              </span>
              <span className="shrink-0 flex flex-col items-end gap-0.5">
                {present(r.state) && (
                  <span
                    data-testid="phone-record-state"
                    className="whitespace-nowrap rounded-full border border-line dark:border-slate-600 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted dark:text-slate-300"
                  >
                    {r.state}
                  </span>
                )}
                {r.aside}
              </span>
              <ChevronRight size={14} className="shrink-0 text-faint dark:text-slate-600" aria-hidden />
            </button>
            {/* Never wider than the row: at 200% text a "− 1 ingredient +"
                stepper went under the name and still ran past the phone (#8432). */}
            {r.trailing && <span className="shrink-0 ml-auto max-w-full pr-2">{r.trailing}</span>}
          </li>
        );
      })}
    </ul>
  );
}
