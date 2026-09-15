// A scan inbox item as a CARD on a phone, sized for the hand (#2982, the
// owner's 14713 and 14714). The picture column stretches with the card and
// shows the whole picture; the content carries what decides the filing:
// the name, one line of provenance, the quantity and a few of the table's
// own fields (a suggestion looks different from a value the person set),
// one line of warning or the one question the row asks, then a compact
// destination + action pair and the way into the full item screen
// ("Details"). The tools a person reaches for on a phone sit on the card
// itself: the camera, Re-run AI with its live running state, and an
// overflow for the rest. The card's brain (InboxCard) computes everything.
import { displayName } from "@cobblr/platform-contract/display-identity";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, CheckCircle, ChevronDown, ChevronRight, Download, Loader2, MoreHorizontal, RotateCcw, ScanLine, Scissors } from "lucide-react";
import type { ScanInboxItem } from "../lib/api";
import { OverlayLayer, BackdropLayer } from "@cobblr/platform-web";

export interface ScanPhoneRowAction {
  label: string;
  hint?: string;
  busy?: boolean;
  danger?: boolean;
  /** The row gave no reason for this tool (its `tool_hints` say possible):
   *  it sits behind the sheet's "More tools" row with this reason under it. */
  folded?: string;
  /** Actions that are one tool (the two box states) count once in the fold. */
  group?: string;
  onClick: () => void;
}

export interface ScanPhoneRowProps {
  item: ScanInboxItem;
  thumb: string | null;
  onThumbBroken: () => void;
  /** Tap the picture: see it full size. Null when there is no picture. */
  onViewImage: (() => void) | null;
  /** One line under the name: barcode, brand, shop, filed-into. */
  subtitle: string;
  /** Amber, one line: the pipeline's warning or the review reason. */
  warning: string | null;
  /** The one question the row asks, with the answers a tap can give
   *  (contract: scanReviewQuestions); shown instead of the warning. */
  question?: {
    prompt: string;
    because: string;
    busy: boolean;
    choices: Array<{ value: string; source: string; onPick: () => void }>;
    onType: (() => void) | null;
  } | null;
  /** The pulse while the AI works. */
  working: string | null;
  /** The last AI run's failure, in words, with Retry beside it. */
  /** The failure line, with the way back the contract names: retry the
   *  lookup, connect a provider, or nothing to press. */
  failure: { text: string; recovery: "retry" | "connect" | null; connectHref?: string } | null;
  /** The quantity, with its editing flow. */
  quantity: { value: number; busy: boolean; onChange: (n: number) => void };
  /** A few of the destination table's own fields, as compact tokens in the
   *  metadata lines. `confirmed` = the person set it; `swatch` = a colour. */
  chips: Array<{ key: string; label: string; value: string; confirmed: boolean; swatch?: string | null }>;
  /** The filing control: the destination's real name and the override on the
   *  left, the small action on the right. Picking a destination never files. */
  commit: {
    kind: "add" | "install" | "review";
    destination: string;
    tentative: boolean;
    reason?: string;
    busy: boolean;
    onAdd: () => void;
    options: Array<{ key: string; label: string; installs: boolean; selected: boolean }>;
    onPick: (key: string) => void;
    /** A table set up after this scan was routed that fits it better
     *  ("Groceries?"): offered beside the pair, never applied on its own. */
    better?: { label: string; onPick: () => void } | null;
  } | null;
  /** The group-photo question, asked on the row because nobody opens a row to find a question. */
  multi: { distinct: number; onSplit: () => void; onKeep: () => void; busy: boolean } | null;
  /** "You already have one": name it, one line. */
  tracked: string | null;
  /** Re-run AI, on the card, with its live state. `failed` is the last run's
   *  verdict (the AI did not answer), so the control reads Retry. */
  rerun: { running: boolean; replaying: boolean; failed: boolean; can: boolean; onRun: () => void };
  onCapture: () => void;
  /** The rest of the item's verbs, in an overflow menu. */
  more: ScanPhoneRowAction[];
  selection: { active: boolean; selected: boolean; onToggle: () => void } | null;
  onOpen: () => void;
}

export function ScanPhoneRow(p: ScanPhoneRowProps) {
  const { item } = p;
  const [pickOpen, setPickOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const name = displayName(item);
  const nameless = !name;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  // The right column's budget at 393px: the card's 24px of padding and a
  // 64px photo column with a 12px gap leave 293px; the quantity control
  // (~84px) and three 40px tools with 6px gaps take 222px. One rendered
  // row, on every ordinary card, whatever the picture's height.
  const tool = "inline-flex min-h-9 min-w-10 shrink-0 items-center justify-center gap-1 rounded-md border border-line dark:border-slate-700 px-2 text-xs text-content dark:text-mortar-100 disabled:opacity-50";
  return (
    <div
      className={
        "relative flex items-start gap-2.5 border-b border-line dark:border-slate-800 px-2.5 py-1.5 " +
        (p.selection?.selected ? "bg-cobble-50/60 dark:bg-cobble-900/20" : "bg-surface dark:bg-slate-900")
      }
    >
      {/* A fixed photo column on the left, the picture top-aligned and
          contained (a tall one capped, never cropped or stretched), and a
          text column whose rows start at the same edge on every card.
          Content sets the height; nothing is added to fill the column
          (#2982, 14723). */}
      <button
        type="button"
        onClick={p.onViewImage ?? p.onOpen}
        aria-label={p.thumb ? "View the picture full size" : "Open the item"}
        className="w-16 shrink-0 overflow-hidden rounded-lg bg-subtle dark:bg-slate-800 flex items-center justify-center"
      >
        {p.thumb ? (
          <img src={p.thumb} alt="" className="max-h-44 w-full object-contain" onError={p.onThumbBroken} />
        ) : (
          <span className="flex h-16 w-full items-center justify-center"><ScanLine size={22} className="text-faint dark:text-slate-600" /></span>
        )}
      </button>
      {p.selection?.active && (
        <label className="absolute left-1.5 top-1.5 z-10 rounded bg-white/85 dark:bg-slate-900/80 p-1 shadow-sm" onClick={stop}>
          <input type="checkbox" checked={p.selection.selected} onChange={p.selection.onToggle} aria-label="Select for bulk action" className="block h-5 w-5 accent-cobble-600" />
        </label>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {/* One flowing paragraph: the name, then the provenance and the
            table's own fields as small inline tokens continuing on the name's
            last line and wrapping from there (the owner: "flow the from after
            the title's 2nd line"). Details floats at the top right, so only
            the first line gives it room. The whole block opens the item. */}
        <div role="button" tabIndex={0} onClick={p.onOpen} onKeyDown={(e) => { if (e.key === "Enter") p.onOpen(); }} className="cursor-pointer leading-snug">
          <button type="button" onClick={(e) => { stop(e); p.onOpen(); }} className="float-right -mr-1 -mt-0.5 ml-2 inline-flex min-h-6 items-center gap-0.5 rounded-md px-1 text-xs font-medium text-accent">
            Details <ChevronRight size={14} />
          </button>
          <span data-name className={"mr-2 text-[15px] " + (nameless ? "text-muted dark:text-slate-400" : "font-medium text-content dark:text-mortar-100")}>
            {name ?? (p.working ? "Reading…" : "Name this item")}
          </span>
          {p.subtitle && <span className="mr-2 font-mono text-[11px] text-faint dark:text-slate-500">{p.subtitle}</span>}
          {p.chips.map((c) => (
            <span
              key={c.key}
              title={`${c.label}: ${c.value}${c.confirmed ? "" : " (suggested)"}`}
              className={"mr-2 inline-flex items-baseline gap-1 whitespace-nowrap text-[11px] " + (c.confirmed ? "text-content dark:text-mortar-100" : "text-muted dark:text-slate-300")}
            >
              <span className="text-faint">{c.label}</span>
              {c.swatch && <span className="inline-block h-2.5 w-2.5 self-center rounded-full border border-line dark:border-slate-600" style={{ background: c.swatch }} />}
              {!c.swatch && <span className={c.confirmed ? "font-medium" : "underline decoration-dotted underline-offset-2"}>{c.value}</span>}
            </span>
          ))}
        </div>
        {p.working && <div className="text-[11px] text-accent animate-pulse">{p.working}</div>}
        {p.question && (
          <div className="text-[11px] leading-5 text-amber-700 dark:text-amber-400" title={p.question.because} data-testid="review-questions">
            <span className="mr-1 font-medium">{p.question.prompt}{p.question.choices.length ? ":" : ":"}</span>
            {p.question.choices.length ? (
              p.question.choices.map((c, i) => (
                <span key={c.value}>
                  {i > 0 && <span className="mx-1 text-faint">or</span>}
                  <button
                    type="button"
                    disabled={p.question!.busy}
                    onClick={c.onPick}
                    className="min-h-7 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-2 font-medium text-amber-800 dark:text-amber-200 disabled:opacity-50"
                    title={c.source}
                  >
                    {c.value}
                  </button>
                </span>
              ))
            ) : (
              <>
                <span className="text-faint">{p.question.because}. </span>
                {p.question.onType && (
                  <button type="button" onClick={p.question.onType} className="underline decoration-dotted underline-offset-2">
                    Type it
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {p.warning && <div className="line-clamp-2 text-[11px] text-amber-600 dark:text-amber-400">{p.warning}</div>}
        {p.failure && (
          <div className="flex items-center gap-2 text-[11px] text-amber-700 dark:text-amber-400" onClick={stop}>
            <span className="line-clamp-2 min-w-0">{p.failure.text}</span>
            {p.failure.recovery === "retry" && p.rerun.can && (
              <button type="button" onClick={p.rerun.onRun} disabled={p.rerun.running} className="shrink-0 rounded border border-amber-400/60 px-2 py-0.5 font-medium">
                Retry
              </button>
            )}
            {p.failure.recovery === "connect" && p.failure.connectHref && (
              <a href={p.failure.connectHref} className="shrink-0 rounded border border-amber-400/60 px-2 py-0.5 font-medium">
                Connect
              </a>
            )}
          </div>
        )}
        {p.tracked && (
          <div className={"line-clamp-1 text-[11px] " + (/^Possible match/.test(p.tracked) ? "text-amber-700 dark:text-amber-400" : "text-moss-700 dark:text-moss-400")}>{p.tracked}</div>
        )}
        {p.multi && (
          <div className="flex items-center gap-1.5 text-[11px]" onClick={stop}>
            <span className="text-content dark:text-mortar-100">{p.multi.distinct} things in this photo</span>
            <button type="button" disabled={p.multi.busy} onClick={p.multi.onSplit} className="inline-flex min-h-8 items-center gap-1 rounded-md bg-cobble-600 px-2 font-medium text-white disabled:opacity-50">
              <Scissors size={11} /> Split
            </button>
            <button type="button" disabled={p.multi.busy} onClick={p.multi.onKeep} className="min-h-8 rounded-md border border-line dark:border-slate-600 px-2 text-muted disabled:opacity-50">
              Keep as one
            </button>
          </div>
        )}
        {/* Two control rows. Quantity and the tools (a better photo, a fresh
            read with its live state, the rest); then the filing pair. */}
        <div data-row="controls" className="flex flex-nowrap items-center gap-1.5" onClick={stop}>
          <span className="inline-flex shrink-0 items-center overflow-hidden rounded-md border border-line dark:border-slate-700 text-xs" title="Quantity">
            <button type="button" aria-label="Decrease quantity" disabled={p.quantity.busy || p.quantity.value <= 1} onClick={() => p.quantity.onChange(p.quantity.value - 1)} className="min-h-9 w-7 text-muted disabled:opacity-40">−</button>
            <span className="min-w-[1.75rem] text-center font-semibold tabular-nums text-content dark:text-mortar-100">×{p.quantity.value}</span>
            <button type="button" aria-label="Increase quantity" disabled={p.quantity.busy} onClick={() => p.quantity.onChange(p.quantity.value + 1)} className="min-h-9 w-7 text-muted disabled:opacity-40">+</button>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
          <button type="button" onClick={p.onCapture} className={tool + " min-w-10 justify-center"} aria-label="Photograph this item" title="Photograph this item">
            <Camera size={15} />
          </button>
          <button
            type="button"
            onClick={p.rerun.onRun}
            disabled={p.rerun.running || !p.rerun.can}
            aria-busy={p.rerun.running}
            aria-label={p.rerun.running ? (p.rerun.replaying ? "Replaying" : "Re-running the AI") : p.rerun.failed ? "Retry the AI" : "Re-run AI"}
            data-state={p.rerun.running ? "running" : p.rerun.failed ? "failed" : "idle"}
            title={p.rerun.running ? "The AI is working on this item" : p.rerun.failed ? "The AI did not answer last time; try again" : "A fresh look at the photo and the code"}
            className={tool + " min-w-10 justify-center" + (p.rerun.failed && !p.rerun.running ? " border-amber-400/70 text-amber-700 dark:text-amber-300" : p.rerun.running ? " border-accent text-accent" : "")}
          >
            {p.rerun.running ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          </button>
          {p.more.length > 0 && (
            <button type="button" onClick={() => setMoreOpen(true)} aria-expanded={moreOpen} aria-label="More item tools" className={tool}>
              <MoreHorizontal size={14} />
            </button>
          )}
          {moreOpen && <PhoneActionSheet title={name ?? "This item"} actions={p.more} onClose={() => setMoreOpen(false)} />}
          </span>
        </div>
        {p.commit && (
          <div data-row="filing" className="flex items-center gap-1.5" onClick={stop}>
            <PhoneCommit c={p.commit} open={pickOpen} setOpen={setPickOpen} onReview={p.onOpen} />
            {p.commit.better && (
              <button
                type="button"
                onClick={p.commit.better.onPick}
                className="inline-flex min-h-9 shrink-0 items-center rounded-full border border-ember-300 dark:border-ember-700 bg-ember-50 dark:bg-ember-900/20 px-2.5 text-[12px] font-medium text-ember-700 dark:text-ember-300"
                title={`${p.commit.better.label} was set up after this scan was routed. Tap to file it there instead.`}
              >
                {p.commit.better.label}?
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The compact filing pair: `[ Groceries ▾ ][ Add ]`. The destination and its
 *  override on the left in the card's own colours; the small action on the
 *  right is the only coloured thing: green to add, amber to review. Picking
 *  never files.
 *
 *  The action is a FILLED segment with its own left edge in every state,
 *  overlapping the destination's right border by a pixel, so the pair reads
 *  as one control whatever the action says. Review used to be an outline
 *  with no left side (border-l-0 against the grey divider), which the owner
 *  read as a different, broken control: "missing yellow line" (#3018). */
function PhoneCommit({ c, open, setOpen, onReview }: { c: NonNullable<ScanPhoneRowProps["commit"]>; open: boolean; setOpen: (v: boolean) => void; onReview: () => void }) {
  const action =
    c.kind === "review"
      ? { label: "Review", cls: "border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-500/80 dark:bg-amber-900/40 dark:text-amber-100", icon: null, onClick: onReview, title: c.reason }
      : c.kind === "install"
        ? { label: "Install & add", cls: "border-cobble-600 bg-cobble-600 text-white", icon: <Download size={13} />, onClick: c.onAdd, title: `${c.destination} is not set up yet; this installs it and files the item` }
        : { label: "Add", cls: "border-emerald-600 bg-emerald-600 text-white", icon: <CheckCircle size={13} />, onClick: c.onAdd, title: `File into ${c.destination}` };
  return (
    <div className="relative flex min-w-0 max-w-full flex-wrap items-stretch">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={`Destination: ${c.destination}. Choose a different destination`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Which table this gets filed into"
        className="inline-flex min-h-9 min-w-0 items-center gap-1 rounded-l-md border border-line dark:border-slate-600 bg-subtle/60 dark:bg-slate-800/60 pl-2 pr-1.5 text-[13px] text-content dark:text-mortar-100"
      >
        <span className="min-w-[4rem] text-left leading-tight">{c.destination}{c.tentative ? "?" : ""}</span>
        <ChevronDown size={14} className={"shrink-0 text-faint transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      <button
        type="button"
        disabled={c.busy}
        onClick={action.onClick}
        title={action.title}
        data-segment="action"
        className={"relative -ml-px inline-flex min-h-9 shrink-0 items-center gap-1 rounded-r-md border px-2.5 text-[13px] font-semibold disabled:opacity-50 " + action.cls}
      >
        {action.icon}
        {action.label}
      </button>
      {open && (
        <>
          <BackdropLayer className="z-30" onClick={() => setOpen(false)} />
          <div role="listbox" className="absolute left-0 top-full z-40 mt-1 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-xl">
            <div className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint">File into</div>
            {c.options.map((o) => (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={o.selected}
                onClick={() => {
                  c.onPick(o.key);
                  setOpen(false);
                }}
                className={"flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm " + (o.selected ? "font-medium text-accent bg-subtle/60 dark:bg-slate-800/60" : "text-content dark:text-mortar-100")}
              >
                <CheckCircle size={14} className={o.selected ? "shrink-0" : "shrink-0 opacity-0"} />
                <span className="min-w-0 truncate">{o.label}</span>
                {o.installs && <span className="ml-auto shrink-0 text-[11px] text-faint">installs on add</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The item's other verbs as a bottom sheet. A desktop dropdown anchored
 *  under its trigger opened below the fold on a phone (the trigger sits in
 *  the card's last rows) while the page was scroll-locked, so the menu was
 *  unreachable and the page felt stuck (the owner, 2026-09-14). A sheet is
 *  always fully on screen; the backdrop, Cancel and any action close it. */
function PhoneActionSheet({ title, actions, onClose }: { title: string; actions: ScanPhoneRowAction[]; onClose: () => void }) {
  // A tool the row's `tool_hints` call possible sits behind one "More tools"
  // row, with the reason it is folded; one they call no is not offered on the
  // phone at all (#3006). Opening the fold keeps the sheet open.
  const [moreOpen, setMoreOpen] = useState(false);
  const inline = actions.filter((a) => !a.folded);
  const folded = actions.filter((a) => !!a.folded);
  const foldedTools = new Set(folded.map((a) => a.group ?? a.label)).size;
  const row = (a: ScanPhoneRowAction) => (
    <button
      key={a.label}
      type="button"
      role="menuitem"
      disabled={a.busy}
      data-folded={a.folded ? "" : undefined}
      onClick={() => {
        onClose();
        a.onClick();
      }}
      className={
        "flex min-h-12 w-full flex-col items-start justify-center px-4 text-left disabled:opacity-50 " +
        (a.danger ? "border-t border-line dark:border-slate-800 text-ember-600 dark:text-ember-400" : "text-content dark:text-mortar-100")
      }
    >
      <span className="text-[15px]">{a.label}</span>
      {(a.folded ?? a.hint) && <span className="text-xs text-faint">{a.folded ?? a.hint}</span>}
    </button>
  );
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return createPortal(
    <OverlayLayer className="z-50 flex items-end bg-slate-900/50" onClick={onClose} role="presentation">
      <div
        role="menu"
        data-sheet
        aria-label={`Tools for ${title}`}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl"
      >
        <div className="truncate px-4 pt-3 pb-1 text-[11px] font-mono uppercase tracking-widest text-faint">{title}</div>
        {inline.map(row)}
        {folded.length > 0 && (
          <>
            <button
              type="button"
              role="menuitem"
              aria-expanded={moreOpen}
              data-testid="more-tools"
              onClick={() => setMoreOpen((v) => !v)}
              className="flex min-h-12 w-full items-center gap-2 border-t border-line dark:border-slate-800 px-4 text-left text-sm text-faint"
            >
              <ChevronDown size={14} className={`shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
              More tools <span className="text-xs">({foldedTools} unlikely for this one)</span>
            </button>
            {moreOpen && folded.map(row)}
          </>
        )}
        <button type="button" role="menuitem" onClick={onClose} className="mt-1 flex min-h-12 w-full items-center justify-center border-t border-line dark:border-slate-800 text-[15px] font-medium text-content dark:text-mortar-100">
          Cancel
        </button>
      </div>
    </OverlayLayer>,
    document.body,
  );
}
