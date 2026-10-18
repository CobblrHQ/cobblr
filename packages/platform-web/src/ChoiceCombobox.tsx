// The one control for a field with choices: a box you type in, over a list.
//
// Focus it and the list opens without typing anything: the field's choices,
// the values already used on records, the ones used most recently first.
// Typing filters the list. What you type IS the value: Enter takes the
// highlighted row if there is one and your text otherwise, and leaving the box
// keeps your text. A value no row matches carries a quiet "new" tag, and a
// field that learns remembers it as a choice from then on (the server does
// that, through the field's writer, so it is undoable). There is no "Add" row
// and no second step to add one: typing is adding.
//
// A field can carry a detail beside its value: the seller of an eBay purchase
// ("eBay · detroitaxle"). On a desktop it is the list's right-hand column, the
// details used with the value under the cursor first, then every other; on a
// phone it is the sheet's second step, which can be skipped.
//
// It replaced the native select with a "+ add new…" option and a separate
// "which one, specifically?" box under it (owner, 2026-10-01: "not anywhere
// close to a gold standard"). lint (scripts/capabilities.ts, choice-picker)
// refuses a hand-rolled "add new" select anywhere else.

import { compareChoices } from "@cobblr/platform-contract/choice-order";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { BackdropLayer, OverlayLayer, PopoverLayer } from "./fixed-layers";

export interface ChoiceOption {
  value: string;
  /** How many records hold it, when known. */
  uses?: number;
  /** When a record last took it (ISO), when known. */
  lastUsed?: string | null;
}

export interface ChoiceDetail {
  /** What the detail is, as its column heads it ("Seller"). */
  label: string;
  value: string | null;
  /** The details used before, for this value first. */
  optionsFor: (value: string | null) => ChoiceOption[];
  onCommit: (v: string | null) => void;
}

export interface ChoiceComboboxProps {
  /** The field's label: the box's accessible name and the phone sheet's title. */
  label: string;
  value: string | null;
  options: readonly ChoiceOption[];
  /** `final` is false for the keystroke-by-keystroke commits of a `live` box,
   *  true once the person has settled on a value (picked, Enter, left the box). */
  onCommit: (v: string | null, final: boolean) => void;
  detail?: ChoiceDetail;
  placeholder?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  className?: string;
  /** Commit on every pick, not only when the box is left (a form that saves
   *  as a whole). */
  live?: boolean;
  /** The box's id, for a host's <label htmlFor>. */
  id?: string;
  /** `data-field` on the box, the hook forms and tests find a field by. */
  dataField?: string;
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The list's order: what was used most recently first, then the most used,
 *  then everything else alphabetically. One rule, so every choice field reads
 *  the same. Values that differ only by case or spacing are one value, kept in
 *  the spelling of whichever came first. */
export function orderChoices(options: readonly ChoiceOption[]): ChoiceOption[] {
  const seen = new Map<string, ChoiceOption>();
  for (const o of options) {
    const v = o.value.trim();
    if (!v) continue;
    const k = norm(v);
    const prev = seen.get(k);
    if (!prev) seen.set(k, { ...o, value: v });
    else {
      prev.uses = (prev.uses ?? 0) + (o.uses ?? 0);
      if (o.lastUsed && (!prev.lastUsed || o.lastUsed > prev.lastUsed)) prev.lastUsed = o.lastUsed;
    }
  }
  const all = [...seen.values()];
  const used = all.filter((o) => (o.uses ?? 0) > 0 || o.lastUsed);
  const unused = all.filter((o) => !((o.uses ?? 0) > 0 || o.lastUsed));
  used.sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "") || (b.uses ?? 0) - (a.uses ?? 0) || compareChoices(a.value, b.value));
  unused.sort((a, b) => compareChoices(a.value, b.value));
  return [...used, ...unused];
}

/** The option a typed text means, by case- and space-insensitive match. */
export function matchChoice(options: readonly ChoiceOption[], text: string): ChoiceOption | null {
  const k = norm(text);
  if (!k) return null;
  return options.find((o) => norm(o.value) === k) ?? null;
}

function usePhone(): boolean {
  const query = "(max-width: 639px)";
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = typeof window !== "undefined" ? window.matchMedia?.(query) : null;
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return phone;
}

export function ChoiceCombobox(props: ChoiceComboboxProps) {
  const phone = usePhone();
  return phone ? <ChoiceSheet {...props} /> : <ChoicePopover {...props} />;
}

/** The value, and its detail beside it: "eBay · detroitaxle". */
function shownValue(value: string | null, detail?: ChoiceDetail): string {
  if (!value) return "";
  return detail?.value ? `${value} · ${detail.value}` : value;
}

function ChoicePopover({ label, value, options, onCommit, detail, placeholder, autoFocus, onCancel, className, live, id, dataField }: ChoiceComboboxProps) {
  const listId = useId();
  const box = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(-1);
  const [detailDraft, setDetailDraft] = useState(detail?.value ?? "");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // What the value was when the list opened: a live box has already committed
  // every keystroke, so "changed" is measured from here, not from `value`.
  const openedWith = useRef<string | null>(value);
  useEffect(() => {
    if (!open) setDraft(value ?? "");
  }, [value, open]);
  useEffect(() => {
    if (!open) setDetailDraft(detail?.value ?? "");
  }, [detail?.value, open]);

  const ordered = useMemo(() => orderChoices(options), [options]);
  const shown = useMemo(() => {
    if (!filtering || !draft.trim()) return ordered;
    const k = norm(draft);
    return ordered.filter((o) => norm(o.value).includes(k));
  }, [ordered, draft, filtering]);
  const exact = matchChoice(ordered, draft);
  const isNew = !!draft.trim() && !exact;
  const focusValue = active >= 0 ? shown[active]?.value ?? null : draft.trim() ? exact?.value ?? draft.trim() : null;
  const detailOptions = useMemo(() => (detail ? orderChoices(detail.optionsFor(focusValue)) : []), [detail, focusValue]);

  const openList = () => {
    setAnchor(box.current?.getBoundingClientRect() ?? null);
    openedWith.current = value;
    setOpen(true);
    setFiltering(false);
    setActive(-1);
  };
  const finish = useCallback(
    (v: string | null, d?: string | null) => {
      const val = v?.trim() ? (matchChoice(ordered, v)?.value ?? v.trim()) : null;
      setOpen(false);
      setFiltering(false);
      setActive(-1);
      setDraft(val ?? "");
      if (val !== (openedWith.current ?? null)) onCommit(val, true);
      openedWith.current = val;
      if (detail) {
        const dv = d === undefined ? detailDraft : d;
        const dval = val && dv?.trim() ? (matchChoice(detailOptions, dv)?.value ?? dv.trim()) : null;
        setDetailDraft(dval ?? "");
        if (dval !== (detail.value ?? null)) detail.onCommit(dval);
      }
    },
    [ordered, value, onCommit, detail, detailDraft, detailOptions],
  );

  // Leaving the picker (the box and its list) keeps what was typed.
  const leave = () => {
    if (!open) return;
    finish(draft, detailDraft);
  };

  useLayoutEffect(() => {
    if (open) setAnchor(box.current?.getBoundingClientRect() ?? null);
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openList();
      setActive((i) => Math.min(i + 1, shown.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active === shown.length) finish(null);
      else finish(active >= 0 ? shown[active]!.value : draft);
      box.current?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(value ?? "");
      setDetailDraft(detail?.value ?? "");
      setOpen(false);
      onCancel?.();
    } else if (e.key === "Tab") {
      finish(active >= 0 && active < shown.length ? shown[active]!.value : draft);
    }
  };

  return (
    <div className={"relative " + (className ?? "")}>
      <div className="relative">
        <input
          ref={box}
          id={id}
          data-field={dataField}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoFocus={autoFocus}
          value={open ? draft : shownValue(value, detail) || ""}
          placeholder={placeholder ?? "None"}
          onFocus={() => {
            if (!open) openList();
          }}
          onClick={() => {
            if (!open) openList();
          }}
          onChange={(e) => {
            if (!open) openList();
            setDraft(e.target.value);
            setFiltering(true);
            setActive(-1);
            if (live) onCommit(e.target.value.trim() ? e.target.value : null, false);
          }}
          onKeyDown={onKey}
          className="input w-full pr-12"
          data-choice-combobox=""
        />
        {open && isNew && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-widest text-accent" data-testid="choice-new">
            new
          </span>
        )}
      </div>
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <BackdropLayer className="z-[60]" onClick={leave} />
            <PopoverLayer
              ref={panel}
              flipAbove={anchor.top}
              style={{ left: anchor.left, top: anchor.bottom + 4, width: detail ? Math.max(anchor.width, 440) : anchor.width }}
              className="z-[61] flex max-h-[min(22rem,60vh)] overflow-hidden rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl"
            >
              <ul id={listId} role="listbox" aria-label={label} className="min-w-0 flex-1 overflow-auto py-1">
                {shown.map((o, i) => (
                  <li
                    key={o.value}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      if (detail) {
                        setDraft(o.value);
                        setActive(i);
                        setFiltering(false);
                        if (live) onCommit(o.value, false);
                      } else finish(o.value);
                    }}
                    className={"cursor-pointer px-3 py-1.5 text-sm " + (i === active ? "bg-subtle dark:bg-slate-800" : "") + (exact?.value === o.value ? " font-medium" : "")}
                  >
                    {o.value}
                    {o.uses ? <span className="ml-2 text-[11px] text-faint">{o.uses}</span> : null}
                  </li>
                ))}
                {shown.length === 0 && !draft.trim() && <li className="px-3 py-1.5 text-sm text-faint">Nothing yet. Type to add one.</li>}
                <li
                  role="option"
                  aria-selected={active === shown.length}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(shown.length)}
                  onClick={() => finish(null)}
                  className={"cursor-pointer border-t border-line dark:border-slate-700 px-3 py-1.5 text-sm text-muted " + (active === shown.length ? "bg-subtle dark:bg-slate-800" : "")}
                >
                  None
                </li>
              </ul>
              {detail && (
                <DetailColumn
                  detail={detail}
                  enabled={!!focusValue}
                  draft={detailDraft}
                  setDraft={setDetailDraft}
                  options={detailOptions}
                  onPick={(d) => finish(focusValue, d)}
                />
              )}
            </PopoverLayer>
          </>,
          document.body,
        )}
    </div>
  );
}

function DetailColumn({
  detail,
  enabled,
  draft,
  setDraft,
  options,
  onPick,
}: {
  detail: ChoiceDetail;
  enabled: boolean;
  draft: string;
  setDraft: (v: string) => void;
  options: ChoiceOption[];
  onPick: (v: string | null) => void;
}) {
  const shown = draft.trim() ? options.filter((o) => norm(o.value).includes(norm(draft))) : options;
  const isNew = !!draft.trim() && !matchChoice(options, draft);
  return (
    <div className="flex w-1/2 min-w-0 flex-col border-l border-line dark:border-slate-700" data-testid="choice-detail-column">
      <div className="relative border-b border-line dark:border-slate-700 p-1.5">
        <input
          aria-label={detail.label}
          disabled={!enabled}
          value={draft}
          placeholder={enabled ? `${detail.label} (optional)` : `Pick one first`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onPick(draft);
            }
          }}
          className="input w-full py-1 text-sm pr-10"
        />
        {isNew && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-widest text-accent">new</span>}
      </div>
      <ul role="listbox" aria-label={detail.label} className="flex-1 overflow-auto py-1">
        {enabled &&
          shown.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={norm(o.value) === norm(draft)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(o.value)}
              className="cursor-pointer px-3 py-1.5 text-sm hover:bg-subtle dark:hover:bg-slate-800"
            >
              {o.value}
            </li>
          ))}
      </ul>
    </div>
  );
}

/** On a phone: the box opens a sheet with the search on top, and a detail as
 *  its second step (skippable). */
function ChoiceSheet({ label, value, options, onCommit, detail, placeholder, className, id, dataField }: ChoiceComboboxProps) {
  const [step, setStep] = useState<"closed" | "value" | "detail">("closed");
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<string | null>(value);
  const ordered = useMemo(() => orderChoices(options), [options]);
  const detailOptions = useMemo(() => (detail ? orderChoices(detail.optionsFor(picked)) : []), [detail, picked]);
  const list = step === "detail" ? detailOptions : ordered;
  const shown = draft.trim() ? list.filter((o) => norm(o.value).includes(norm(draft))) : list;
  const isNew = !!draft.trim() && !matchChoice(list, draft);
  const close = () => {
    setStep("closed");
    setDraft("");
  };
  const take = (v: string | null) => {
    const val = v?.trim() ? (matchChoice(list, v)?.value ?? v.trim()) : null;
    if (step === "value") {
      if (val !== (value ?? null)) onCommit(val, true);
      setPicked(val);
      if (detail && val) {
        setStep("detail");
        setDraft("");
        return;
      }
      close();
    } else {
      if (detail && val !== (detail.value ?? null)) detail.onCommit(val);
      close();
    }
  };
  return (
    <>
      <button
        type="button"
        id={id}
        data-field={dataField}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => {
          setPicked(value);
          setDraft("");
          setStep("value");
        }}
        className={"input w-full text-left " + (value ? "" : "text-faint ") + (className ?? "")}
        data-choice-combobox=""
      >
        {shownValue(value, detail) || placeholder || "None"}
      </button>
      {step !== "closed" &&
        typeof document !== "undefined" &&
        createPortal(
          // The sheet covers the whole screen, so it keeps the status bar and
          // the home bar clear itself: its search and Cancel sat under the
          // clock on an iPhone.
          <OverlayLayer role="dialog" aria-modal="true" aria-label={label} className="z-[70] flex flex-col bg-surface dark:bg-slate-900" style={{ paddingTop: "var(--safe-top)", paddingBottom: "var(--inset-bottom)" }}>
            <div className="flex items-center gap-2 border-b border-line dark:border-slate-700 p-3">
              <div className="relative flex-1">
                <input
                  autoFocus
                  aria-label={step === "detail" ? detail?.label : label}
                  value={draft}
                  placeholder={step === "detail" ? `${detail?.label} (optional)` : `Search or type ${label.toLowerCase()}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") take(draft || null);
                    if (e.key === "Escape") close();
                  }}
                  className="input w-full pr-12 text-base"
                />
                {isNew && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-widest text-accent">new</span>}
              </div>
              <button type="button" onClick={() => (draft.trim() ? take(draft) : step === "detail" ? take(null) : close())} className="px-3 py-2 text-sm text-accent">
                {draft.trim() ? "Done" : step === "detail" ? "Skip" : "Cancel"}
              </button>
            </div>
            {step === "detail" && picked && <div className="px-3 pt-2 text-xs text-muted">{picked} ·</div>}
            <ul role="listbox" aria-label={step === "detail" ? detail?.label : label} className="flex-1 overflow-auto">
              {shown.map((o) => (
                <li key={o.value} role="option" aria-selected={false} onClick={() => take(o.value)} className="cursor-pointer border-b border-line/60 dark:border-slate-800 px-4 py-3 text-base">
                  {o.value}
                </li>
              ))}
              {step === "value" && (
                <li role="option" aria-selected={false} onClick={() => take(null)} className="cursor-pointer px-4 py-3 text-base text-muted">
                  None
                </li>
              )}
            </ul>
          </OverlayLayer>,
          document.body,
        )}
    </>
  );
}
