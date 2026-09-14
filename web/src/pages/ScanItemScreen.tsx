// A scan inbox item as ITS OWN SCREEN on a phone. Designed for the hand, from
// the #2982 concept, not cut down from the desktop card: one scrolling
// column in the order a person decides in (what is it, what does it look
// like, where does it go and with what details, what the AI said if you
// care, how to correct it, what else you can do to it), a pinned header to
// leave or move on, a pinned footer with the one filing action.
//
// The card's brain (InboxCard) computes every value and mutation and hands
// this screen data, callbacks and a few SLOTS (the confirm form, the photo
// strip, the evidence box, the correction box, the viewer and the sheets),
// which are the same components the desktop card renders. Two layouts, one
// set of behaviours.
import { useState, type ReactNode } from "react";
import { Camera, ChevronDown, Pencil, ReceiptText, RefreshCw, RotateCcw, Scissors, Sparkles, Undo2, X } from "lucide-react";
import type { ScanInboxItem } from "../lib/api";
import { ScanItemSheetHeader, ScanItemSheetFooter, type ScanItemSheetNav } from "./ScanItemSheet";

export interface ScanItemScreenAction {
  label: string;
  icon?: ReactNode;
  hint?: string;
  busy?: boolean;
  tone?: "default" | "danger";
  /** The row gave no reason for this tool (its `tool_hints` say possible):
   *  it sits behind the "More tools" fold with this reason under it. */
  folded?: string;
  /** Actions that are one tool (the two box states) count once in the fold. */
  group?: string;
  onClick: () => void;
}

export interface ScanItemScreenProps {
  item: ScanInboxItem;
  nav: ScanItemSheetNav;
  subtitle: string;
  /** The barcode, shown under the title and edited there: one control, a
   *  44px hit area around a compact label. Saving re-runs the lookup. */
  barcode: {
    value: string | null;
    editing: boolean;
    draft: string;
    valid: boolean;
    pending: boolean;
    canEdit: boolean;
    onStart: () => void;
    onDraft: (v: string) => void;
    onSave: () => void;
    onCancel: () => void;
  };
  warning: string | null;
  working: string | null;
  /** What this row still asks of a person, and the taps that answer it
   *  (the contract's scanReviewQuestions): the one question, a choice per
   *  answer the pipeline can offer, and the resolving actions (Looks fine,
   *  fixing the barcode, typing the value). Leads the screen, before the
   *  pictures and the form; null when nothing is flagged, and then none of
   *  it renders, Looks fine included (#3018). */
  review: {
    prompt: string;
    because: string;
    busy: boolean;
    choices: Array<{ value: string; source: string; onPick: () => void }>;
    actions: Array<{ label: string; hint?: string; busy?: boolean; onClick: () => void }>;
  } | null;
  /** "Use photo's name: X", when the photo read a different product off the label. */
  photoName: { name: string; busy: boolean; onApply: () => void } | null;
  multi: { distinct: number; names: string[]; onSplit: () => void; onKeep: () => void; busy: boolean } | null;
  pictures: {
    yours: string | null;
    catalog: string | null;
    catalogChecking: boolean;
    onOpenYours: () => void;
    onOpenCatalog: () => void;
    onCapture: () => void;
    onRetake: (() => void) | null;
    onYoursBroken: () => void;
    onCatalogBroken: () => void;
  };
  /** The item's other verbs, as a list of buttons, not a menu. */
  actions: ScanItemScreenAction[];
  slots: {
    nameIt?: ReactNode;
    tracked?: ReactNode;
    strip?: ReactNode;
    form: ReactNode;
    evidence?: ReactNode;
    correction?: ReactNode;
    overlays?: ReactNode;
  };
  footer: {
    formOpen: boolean;
    addLabel: string;
    onOpenForm: () => void;
    onDiscard: () => void;
    discardPending: boolean;
    setActionSlot: (el: HTMLDivElement | null) => void;
  };
}

/** The one question a flagged row asks, first on the screen. A choice is a
 *  tap answer; the actions are the other ways to settle it. The reason sits
 *  under the question in words, not as a percentage. */
function ReviewBlock({ r, barcode }: { r: NonNullable<ScanItemScreenProps["review"]>; barcode: ScanItemScreenProps["barcode"] }) {
  const action = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium disabled:opacity-50";
  return (
    <section
      data-testid="review-block"
      aria-label="Needs your review"
      className="rounded-xl border border-amber-400/70 bg-amber-50 dark:bg-amber-900/15 dark:border-amber-500/50 px-3 py-2.5 space-y-2"
    >
      <div className="text-[10px] font-mono uppercase tracking-widest text-amber-700 dark:text-amber-300">Needs your review</div>
      <div className="text-[15px] font-medium leading-snug text-content dark:text-mortar-100">{r.prompt}</div>
      {r.because && <div className="text-xs leading-snug text-muted dark:text-slate-300">{r.because}</div>}
      {r.choices.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {r.choices.map((c) => (
            <button
              key={c.value}
              type="button"
              disabled={r.busy}
              onClick={c.onPick}
              title={c.source}
              className={action + " border-amber-400/70 bg-surface dark:bg-slate-900 text-amber-900 dark:text-amber-100"}
            >
              {c.value}
              <span aria-hidden className="text-[11px] font-normal text-faint">{c.source}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {r.actions.map((a) => (
          <button key={a.label} type="button" disabled={r.busy || a.busy} onClick={a.onClick} title={a.hint} className={action + " border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-100"}>
            {a.label}
          </button>
        ))}
        {barcode.canEdit && !barcode.editing && (
          <button type="button" onClick={barcode.onStart} title={barcode.value ? "Fix the barcode; saving re-runs the lookup on the corrected code" : "Type the barcode off the label; it identifies the product exactly"} className={action + " border-line dark:border-slate-600 bg-surface dark:bg-slate-900 text-content dark:text-mortar-100"}>
            <Pencil size={13} className="text-faint" /> {barcode.value ? "Fix the barcode" : "Add the barcode"}
          </button>
        )}
      </div>
    </section>
  );
}

/** The item's other tools. A tool the row's `tool_hints` call likely is a
 *  button; one they call possible sits behind one "More tools" row with the
 *  reason it is folded; one they call no is not on the phone at all (the
 *  desktop menu has the room to fold those too). Every capability the row
 *  can use stays reachable; nothing unrequested is read first (#3006). */
function MoreSection({ actions }: { actions: ScanItemScreenAction[] }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const inline = actions.filter((a) => !a.folded);
  const folded = actions.filter((a) => !!a.folded);
  const foldedTools = new Set(folded.map((a) => a.group ?? a.label)).size;
  const button = (a: ScanItemScreenAction) => (
    <button
      key={a.label}
      type="button"
      disabled={a.busy}
      onClick={a.onClick}
      title={a.hint}
      data-folded={a.folded ? "" : undefined}
      className={
        "inline-flex min-h-11 flex-col items-center justify-center rounded-lg border px-3 py-1 text-sm disabled:opacity-50 " +
        (a.tone === "danger"
          ? "border-ember-300 dark:border-ember-700 text-ember-600 dark:text-ember-400"
          : "border-line dark:border-slate-700 text-content dark:text-mortar-100")
      }
    >
      <span className="inline-flex items-center gap-1.5">
        {a.icon}
        {a.label}
      </span>
      {a.folded && <span className="text-[11px] leading-tight text-faint">{a.folded}</span>}
    </button>
  );
  return (
    <Section title="More">
      {inline.length > 0 && <div className="grid grid-cols-2 gap-2">{inline.map(button)}</div>}
      {folded.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={moreOpen}
            data-testid="more-tools"
            onClick={() => setMoreOpen((v) => !v)}
            className={`flex min-h-11 w-full items-center gap-2 text-left text-sm text-faint ${inline.length > 0 ? "mt-2" : ""}`}
          >
            <ChevronDown size={14} className={`shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
            More tools <span className="text-[11px]">({foldedTools} unlikely for this one)</span>
          </button>
          {moreOpen && <div className="grid grid-cols-2 gap-2">{folded.map(button)}</div>}
        </>
      )}
    </Section>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Picture({ src, caption, empty, onOpen, onBroken }: { src: string | null; caption: string; empty: string; onOpen: () => void; onBroken: () => void }) {
  return (
    <figure className="min-w-0">
      {src ? (
        <button type="button" onClick={onOpen} className="block w-full overflow-hidden rounded-xl border border-line dark:border-slate-700 bg-black/90" title="View full size">
          <img src={src} alt={caption} className="h-40 w-full object-contain" onError={onBroken} />
        </button>
      ) : (
        <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-line dark:border-slate-700 text-sm text-faint">{empty}</div>
      )}
      <figcaption className="mt-1 text-[10px] font-mono uppercase tracking-widest text-faint">{caption}</figcaption>
    </figure>
  );
}

export function ScanItemScreen(p: ScanItemScreenProps) {
  const { item } = p;
  return (
    <div className="bg-surface dark:bg-slate-900">
      <ScanItemSheetHeader nav={p.nav} />
      <div className="space-y-6 px-4 pb-4 pt-3">
        <section className="space-y-1.5">
          <h2 className={"text-xl font-semibold leading-tight " + (item.suggested_name ? "text-content dark:text-mortar-100" : "text-muted dark:text-slate-400")}>
            {item.suggested_name ?? "Name this item"}
          </h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-faint dark:text-slate-500">
            {p.barcode.editing ? (
              <span className="flex w-full items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <input
                  autoFocus
                  inputMode="numeric"
                  value={p.barcode.draft}
                  onChange={(e) => p.barcode.onDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") p.barcode.onSave();
                    else if (e.key === "Escape") p.barcode.onCancel();
                  }}
                  placeholder="digits from the label"
                  className="min-h-11 min-w-0 flex-1 rounded-md border border-accent bg-surface dark:bg-slate-900 px-2.5 font-mono text-sm text-content outline-none"
                />
                <button
                  type="button"
                  disabled={p.barcode.pending || !p.barcode.valid}
                  onClick={p.barcode.onSave}
                  className="min-h-11 shrink-0 rounded-md bg-cobble-600 px-3 text-sm font-medium text-white disabled:opacity-50"
                >
                  {p.barcode.pending ? "Looking up…" : "Save & re-run"}
                </button>
                <button type="button" onClick={p.barcode.onCancel} aria-label="Cancel barcode edit" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-faint">
                  <X size={16} />
                </button>
              </span>
            ) : p.barcode.canEdit ? (
              <button
                type="button"
                onClick={p.barcode.onStart}
                aria-label={p.barcode.value ? "Edit the barcode" : "Add a barcode"}
                title={p.barcode.value ? "Fix the barcode; saving re-runs the lookup on the corrected code" : "Type the barcode off the label; it identifies the product exactly"}
                data-testid="phone-barcode"
                className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-[11px] font-mono text-content dark:text-mortar-200 active:bg-subtle dark:active:bg-slate-800"
              >
                {p.barcode.value ? (
                  <>
                    <span>▌▌{p.barcode.value}</span>
                    <Pencil size={11} className="text-faint" />
                  </>
                ) : (
                  <span className="rounded border border-dashed border-line dark:border-slate-700 px-1.5 py-0.5 text-muted">▌▌ Add barcode</span>
                )}
              </button>
            ) : (
              p.barcode.value && <span>▌▌{p.barcode.value}</span>
            )}
            {p.subtitle && <span>{p.subtitle}</span>}
          </div>
          {p.working && <div className="text-xs text-accent animate-pulse">{p.working}</div>}
          {p.warning && !p.review && <div className="text-xs text-amber-600 dark:text-amber-400">{p.warning}</div>}
          {p.photoName && (
            <button
              type="button"
              disabled={p.photoName.busy}
              onClick={p.photoName.onApply}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 disabled:opacity-50"
            >
              <Sparkles size={12} /> Use the photo's name: "{p.photoName.name}"
            </button>
          )}
          {p.slots.nameIt}
          {p.slots.tracked}
          {p.multi && (
            <div className="rounded-lg border border-cobble-500/50 bg-cobble-600/10 px-3 py-2 text-sm">
              <div className="text-content dark:text-mortar-100">
                <strong>{p.multi.distinct} different things</strong> in this photo.
              </div>
              {p.multi.names.length > 0 && <div className="mt-0.5 truncate text-xs text-muted">{p.multi.names.join(" · ")}</div>}
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={p.multi.busy} onClick={p.multi.onSplit} className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                  <Scissors size={13} /> Split into {p.multi.distinct}
                </button>
                <button type="button" disabled={p.multi.busy} onClick={p.multi.onKeep} className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-sm text-muted disabled:opacity-50">
                  Keep as one
                </button>
              </div>
            </div>
          )}
        </section>

        {p.review && <ReviewBlock r={p.review} barcode={p.barcode} />}

        <Section
          title="Pictures"
          aside={
            <div className="flex gap-1.5">
              <button type="button" onClick={p.pictures.onCapture} className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-700 px-2 py-1 text-xs text-content">
                <Camera size={13} /> Photo
              </button>
              {p.pictures.onRetake && (
                <button type="button" onClick={p.pictures.onRetake} className="inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-700 px-2 py-1 text-xs text-content">
                  <RotateCcw size={13} /> Retake
                </button>
              )}
            </div>
          }
        >
          {/* Catalog first, then yours, the desktop's order (the owner, #2982). */}
          <div className="grid grid-cols-2 gap-2">
            <Picture
              src={p.pictures.catalog}
              caption={p.pictures.catalogChecking ? "Catalog, checking" : "Catalog"}
              empty="No picture"
              onOpen={p.pictures.onOpenCatalog}
              onBroken={p.pictures.onCatalogBroken}
            />
            <Picture src={p.pictures.yours} caption="Your photo" empty="No photo yet" onOpen={p.pictures.onOpenYours} onBroken={p.pictures.onYoursBroken} />
          </div>
          {p.slots.strip}
        </Section>

        <Section title="Where it goes, and its details">{p.slots.form}</Section>

        {p.slots.evidence && <Section title="What the AI found">{p.slots.evidence}</Section>}
        {p.slots.correction && <Section title="Correct it">{p.slots.correction}</Section>}

        {p.actions.length > 0 && <MoreSection actions={p.actions} />}
      </div>
      <ScanItemSheetFooter
        formOpen={p.footer.formOpen}
        addLabel={p.footer.addLabel}
        onOpenForm={p.footer.onOpenForm}
        onCancel={p.nav.onClose}
        onDiscard={p.footer.onDiscard}
        discardPending={p.footer.discardPending}
        setActionSlot={p.footer.setActionSlot}
      />
      {p.slots.overlays}
    </div>
  );
}

// Icons the card reaches for when it builds the action list, re-exported so
// ScanPage does not grow another import line per verb.
export const screenIcons = { receipt: <ReceiptText size={14} />, replay: <RefreshCw size={14} />, undo: <Undo2 size={14} />, split: <Scissors size={14} /> };
