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
import { lineRuns } from "../lib/placeLine";
import { displayName } from "@cobblr/platform-contract/display-identity";
import { scanToolsFold, scanToolsFoldGroups } from "@cobblr/platform-contract/scan-triage";
import { thumbnailFit, thumbnailTextHeavy, type ThumbFit } from "@cobblr/platform-contract/thumbnail-fit";
import type { ScanTool, ScanToolHints } from "@cobblr/platform-contract/scan-tools";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { createPortal } from "react-dom";
import { Camera, CheckCircle, ChevronDown, ChevronRight, Download, Loader2, MoreHorizontal, PackagePlus, RotateCcw, ScanLine, Scissors } from "lucide-react";
import type { ScanInboxItem } from "../lib/api";
import { NumberStepper, OverlayLayer, useEscapeToClose, useLockPageScroll } from "@cobblr/platform-web";
import { ScanReceiptUnread, type ScanReceiptUnreadProps } from "../components/ScanReceiptUnread";
import { DestinationPicker } from "../components/DestinationPicker";
import { RECEIPT_UNREAD_TITLE } from "@cobblr/platform-contract/scan-copy";

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
  /** The tool this action belongs to (the row's tool_hints key), so the
   *  fold counts and names tools rather than buttons. */
  tool?: ScanTool;
  onClick: () => void;
}

export interface ScanPhoneRowProps {
  item: ScanInboxItem;
  thumb: string | null;
  /** Said in the picture's place when there is none: a picture that could
   *  not be kept. */
  pictureNote?: ReactNode;
  onThumbBroken: () => void;
  /** Tap the picture: see it full size. Null when there is no picture. */
  onViewImage: (() => void) | null;
  /** One line under the name: barcode, brand, shop, filed-into. */
  subtitle: string;
  /** Amber, one line: the pipeline's warning or the review reason. */
  warning: string | null;
  /** What the row's own kind adds under it, on the closed card: an order
   *  line's units and the "Part of …?" offer (#5734), a pack's note. */
  extra?: ReactNode;
  /** The one question the row asks, with the answers a tap can give
   *  (contract: scanReviewQuestions); shown instead of the warning. */
  question?: {
    prompt: string;
    because: string;
    busy: boolean;
    choices: Array<{ value: string; source: string; onPick: () => void }>;
    onType: (() => void) | null;
  } | null;
  /** A receipt whose lines could not be read (contract:
   *  scanReceiptReadFailed): the row says so with Read again, never "Name
   *  this item" (#3581). */
  receipt?: Omit<ScanReceiptUnreadProps, "compact"> | null;
  /** The pulse while the AI works. */
  working: string | null;
  /** The last AI run's failure, in words, with Retry beside it. */
  /** The failure line, with the way back the contract names: retry the
   *  lookup, connect a provider, or nothing to press. */
  failure: { text: string; recovery: "retry" | "connect" | null; connectHref?: string } | null;
  /** The quantity, with its editing flow. Null for a row that is not an
   *  item yet (a receipt whose lines could not be read): nothing to count. */
  quantity: {
    value: number;
    busy: boolean;
    onChange: (n: number) => void;
    /** A match on a record the workspace counts: the stepper is a CHANGE to
     *  that record, not how many this scan holds. It reads +1 / −1, goes
     *  below zero down to `floor` (taking what is there), and skips zero
     *  (#3884: "where is my −1 button"). */
    signed?: { floor: number };
    /** A measured record: the change is typed in fractions of its unit (#6142). */
    decimal?: boolean;
  } | null;
  /** A few of the destination table's own fields, as compact tokens in the
   *  metadata lines. `confirmed` = the person set it; `swatch` = a colour. */
  chips: Array<{ key: string; label: string; value: string; confirmed: boolean; swatch?: string | null }>;
  /** The filing control: the destination's real name and the override on the
   *  left, the small action on the right. Picking a destination never files. */
  commit: {
    /** `merge` is +1 more of a record the workspace counts; onAdd runs it.
     *  `ask` is a row this person cannot file (a permission, a bundle only an
     *  admin installs): onAdd raises the ask instead of a File (#3073). */
    kind: "add" | "install" | "merge" | "review" | "ask";
    /** The action's words, from the row's resolved state (scanRowState):
     *  the same words the desk card and the session show. */
    label: string;
    destination: string;
    /** What the action does to the destination, kept whole beside its name
     *  ("6 → 9" on a repeat scan) while a long name gives way. */
    destinationNote?: string;
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
  /** The record it matched, opened from the line. */
  trackedHref?: string | null;
  /** Re-run AI, on the card, with its live state. `failed` is the last run's
   *  verdict (the AI did not answer), so the control reads Retry. */
  rerun: { running: boolean; replaying: boolean; failed: boolean; can: boolean; onRun: () => void };
  onCapture: () => void;
  /** The rest of the item's verbs, in an overflow menu. */
  more: ScanPhoneRowAction[];
  /** The row's tool_hints, for the fold's words. */
  toolHints?: ScanToolHints | null;
  selection: { active: boolean; selected: boolean; onToggle: () => void } | null;
  onOpen: () => void;
}

export function ScanPhoneRow(p: ScanPhoneRowProps) {
  const { item } = p;
  const [moreOpen, setMoreOpen] = useState(false);
  // A long thin thing lying flat is a sliver in this 64px column; turned a
  // quarter it runs the column's height. Measured from the picture's own
  // size when it loads, decided by the contract's fit rule, display only:
  // the stored picture and the lightbox keep the orientation as taken
  // (#3066). Words are never turned (packaging in frame, a book).
  const [thumbFit, setThumbFit] = useState<ThumbFit>({ rotate: 0, gain: 1 });
  const textHeavy = thumbnailTextHeavy(item.suggested_metadata);
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
        title={p.thumb ? "View the picture full size" : "Open the item"}
        className="w-16 shrink-0 overflow-hidden rounded-lg bg-subtle dark:bg-slate-800 flex items-center justify-center"
      >
        {p.thumb ? (
          // Turned: a 128 by 64 box, contained, rotated a quarter about its
          // centre, sits inside a 64 by 128 frame (the row's height budget).
          <span className={thumbFit.rotate ? "relative block h-32 w-16 overflow-hidden" : "block w-full"} data-rotate={thumbFit.rotate || undefined}>
            <img
              src={p.thumb}
              alt=""
              className={thumbFit.rotate ? "absolute object-contain" : "max-h-44 w-full object-contain"}
              style={thumbFit.rotate ? { width: 128, maxWidth: "none", height: 64, left: -32, top: 32, transform: "rotate(90deg)" } : undefined}
              onLoad={(e) => {
                const img = e.currentTarget;
                setThumbFit(thumbnailFit({ width: img.naturalWidth, height: img.naturalHeight }, { width: 64, maxHeight: 128 }, { textHeavy }));
              }}
              onError={p.onThumbBroken}
            />
          </span>
        ) : (
          <span className="flex h-16 w-full items-center justify-center">{p.pictureNote ?? <ScanLine size={22} className="text-faint dark:text-slate-600" />}</span>
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
            {name ?? (p.working ? "Reading…" : p.receipt ? RECEIPT_UNREAD_TITLE : "Name this item")}
          </span>
          {p.subtitle && (
            <span data-testid="scan-card-meta" className="mr-2 text-[11px] text-faint dark:text-slate-500">
              {lineRuns(p.subtitle).map((r, i) => (r.place ? <span key={i} data-place-run="" className="inline-block">{r.text}</span> : r.text))}
            </span>
          )}
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
        {p.receipt && !p.working && <ScanReceiptUnread {...p.receipt} compact />}
        {p.question && !p.receipt && (
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
                  {/* One answer on offer is a guess, and where it came from
                      is what makes taking it honest (a held web guess: "found
                      on the web, not confirmed"), so it reads beside the tap,
                      with the way to type something else instead. */}
                  {p.question!.choices.length === 1 && (
                    <>
                      <span className="ml-1 text-faint">{c.source}</span>
                      {p.question!.onType && (
                        <>
                          <span className="mx-1 text-faint">or</span>
                          <button type="button" onClick={p.question!.onType} className="underline decoration-dotted underline-offset-2">
                            Type it
                          </button>
                        </>
                      )}
                    </>
                  )}
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
        {p.warning && !p.receipt && <div className="line-clamp-2 text-[11px] text-amber-600 dark:text-amber-400">{p.warning}</div>}
        {p.extra}
        {p.failure && !p.receipt && (
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
        {p.tracked &&
          (p.trackedHref ? (
            <Link
              to={p.trackedHref}
              onClick={stop}
              data-testid="tracked-line"
              title={`Open the record${/^Possible match/.test(p.tracked) ? "" : " you already have"}`}
              className={"line-clamp-1 text-[11px] underline decoration-dotted underline-offset-2 " + (/^Possible match/.test(p.tracked) ? "text-amber-700 dark:text-amber-400" : "text-moss-700 dark:text-moss-400")}
            >
              {p.tracked}
            </Link>
          ) : (
            <div data-testid="tracked-line" className={"line-clamp-1 text-[11px] " + (/^Possible match/.test(p.tracked) ? "text-amber-700 dark:text-amber-400" : "text-moss-700 dark:text-moss-400")}>{p.tracked}</div>
          ))}
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
            read with its live state, the rest); then the filing pair. The
            tools wrap under the quantity when they do not fit: held on one
            line at a phone's larger text, they made the page wider than the
            screen and the browser zoomed the whole app out (#3930). */}
        <div data-row="controls" className="flex flex-wrap items-center gap-1.5" onClick={stop}>
          {p.quantity && (() => {
            const q = p.quantity;
            return (
              <NumberStepper
                className="inline-flex shrink-0 items-center overflow-hidden rounded-md border border-line dark:border-slate-700 text-xs"
                value={q.value}
                busy={q.busy}
                // A signed row is a CHANGE to stock the person has (+3 / −2): it
                // skips zero and may be typed negative. Otherwise it is the
                // count of a new capture, one at least.
                signed={!!q.signed}
                // A measured record's change is typed in fractions (#6142).
                decimal={!!q.decimal}
                min={q.signed ? q.signed.floor : 1}
                label={q.signed ? "Change by" : "Quantity"}
                decreaseLabel={q.signed ? "One less" : "Decrease quantity"}
                increaseLabel={q.signed ? "One more" : "Increase quantity"}
                inputTestId={q.signed ? "row-change" : undefined}
                buttonClassName="min-h-9 w-7 text-muted disabled:opacity-40"
                inputClassName={"w-9 bg-transparent text-center font-semibold tabular-nums " + (q.signed && q.value < 0 ? "text-ember-700 dark:text-ember-300" : "text-content dark:text-mortar-100")}
                onChange={q.onChange}
              />
            );
          })()}
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
            title={p.rerun.running ? "Re-running: the AI is working on this item" : p.rerun.failed ? "Retry: ask the AI again" : "Re-run AI: a fresh look at the photo and the code"}
            className={tool + " min-w-10 justify-center" + (p.rerun.failed && !p.rerun.running ? " border-amber-400/70 text-amber-700 dark:text-amber-300" : p.rerun.running ? " border-accent text-accent" : "")}
          >
            {p.rerun.running ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          </button>
          {p.more.length > 0 && (
            <button title="More item tools" type="button" onClick={() => setMoreOpen(true)} aria-expanded={moreOpen} aria-label="More item tools" className={tool}>
              <MoreHorizontal size={14} />
            </button>
          )}
          {moreOpen && <PhoneActionSheet title={name ?? "This item"} actions={p.more} hints={p.toolHints} onClose={() => setMoreOpen(false)} />}
          </span>
        </div>
        {p.commit && (
          <div data-row="filing" className="flex items-center gap-1.5" onClick={stop}>
            <PhoneCommit c={p.commit} onReview={p.onOpen} />
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
function PhoneCommit({ c, onReview }: { c: NonNullable<ScanPhoneRowProps["commit"]>; onReview: () => void }) {
  // The words are the contract's (scanRowState.action.label, handed down as
  // c.label); this only colours them. A second copy of "Install & add" here
  // is how the list and the card once disagreed (#3076).
  const action =
    c.kind === "review"
      ? { label: c.label, cls: "border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-500/80 dark:bg-amber-900/40 dark:text-amber-100", icon: null, onClick: onReview, title: c.reason }
      : c.kind === "ask"
        ? { label: c.label, cls: "border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-500/80 dark:bg-amber-900/40 dark:text-amber-100", icon: null, onClick: c.onAdd, title: c.reason }
      : c.kind === "install"
        ? { label: c.label, cls: "border-cobble-600 bg-cobble-600 text-white", icon: <Download size={13} />, onClick: c.onAdd, title: `${c.destination} is not set up yet; this installs it and files the item` }
        : c.kind === "merge"
          ? { label: c.label, cls: "border-emerald-600 bg-emerald-600 text-white", icon: <PackagePlus size={13} />, onClick: c.onAdd, title: c.reason }
          : { label: c.label, cls: "border-emerald-600 bg-emerald-600 text-white", icon: <CheckCircle size={13} />, onClick: c.onAdd, title: `File into ${c.destination}` };
  // The menu is the one every filing surface opens (DestinationPicker):
  // portalled, kept on the screen, scrolling its own list (#3930, #6527).
  return (
    // One row, the destination and its action (#6245, the owner's "the
    // controls take up 3 rows ... they can get down to 2"): a long name is
    // cut to fit and said whole in its label, where it used to wrap and push
    // the action onto a row of its own. The name keeps its first letters: a
    // long action ("Turn on Filament and add") wraps inside its own button
    // rather than cutting the name to nothing at 320 (#6480).
    <div className="relative flex min-w-0 max-w-full items-stretch">
      <DestinationPicker
        options={c.options}
        value={c.options.find((o) => o.selected)?.key ?? null}
        onPick={c.onPick}
        trigger={(t) => (
          <button
            type="button"
            ref={t.ref}
            {...t.props}
            onClick={t.toggle}
            aria-label={`Destination: ${c.destination}${c.destinationNote ? `: ${c.destinationNote}` : ""}. Choose a different destination`}
            title={`${c.destination}${c.destinationNote ? `: ${c.destinationNote}` : ""}. Which table this gets filed into`}
            className="inline-flex min-h-9 min-w-0 items-center gap-1 rounded-l-md border border-line dark:border-slate-600 bg-subtle/60 dark:bg-slate-800/60 pl-2 pr-1.5 text-[13px] text-content dark:text-mortar-100"
          >
            <span className="min-w-[5ch] truncate text-left leading-tight">{c.destination}{c.tentative ? "?" : ""}</span>
            {c.destinationNote && <span data-destination-note className="shrink-0 whitespace-nowrap text-left leading-tight tabular-nums">{c.destinationNote}</span>}
            <ChevronDown size={14} className={"shrink-0 text-faint transition-transform " + (t.open ? "rotate-180" : "")} />
          </button>
        )}
      />
      <button
        type="button"
        disabled={c.busy}
        onClick={action.onClick}
        title={action.title}
        data-segment="action"
        // As narrow as its longest word and no narrower: it wraps between
        // words ("Turn on Filament / and add"), never inside one ("+1 / 0 /
        // mo / re" beside a long name and its 0 → 10, #6527). The name is
        // what gives way.
        className={"relative -ml-px inline-flex min-h-9 min-w-min items-center gap-1 rounded-r-md border px-2.5 text-left text-[13px] font-semibold leading-tight [overflow-wrap:normal] disabled:opacity-50 " + action.cls}
      >
        {action.icon && <span className="shrink-0">{action.icon}</span>}
        <span>{action.label}</span>
      </button>
    </div>
  );
}

/** The item's other verbs as a bottom sheet. A desktop dropdown anchored
 *  under its trigger opened below the fold on a phone (the trigger sits in
 *  the card's last rows) while the page was scroll-locked, so the menu was
 *  unreachable and the page felt stuck (the owner, 2026-09-14). A sheet is
 *  always fully on screen; the backdrop, Cancel and any action close it. */
function PhoneActionSheet({ title, actions, hints, onClose }: { title: string; actions: ScanPhoneRowAction[]; hints: ScanToolHints | null | undefined; onClose: () => void }) {
  // A tool the row's `tool_hints` call possible sits behind one "More tools"
  // row, with the reason it is folded; one they call no is not offered on the
  // phone at all (#3006). Opening the fold keeps the sheet open.
  const [moreOpen, setMoreOpen] = useState(false);
  const inline = actions.filter((a) => !a.folded);
  const folded = actions.filter((a) => !!a.folded);
  // The fold's words come from the same place as the tools it counts
  // (scanToolsFold, #3075).
  const foldLabel = scanToolsFold(hints, folded.map((a) => a.tool).filter((t): t is ScanTool => !!t)).label;
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
      {a.hint && <span className="text-xs text-faint">{a.hint}</span>}
    </button>
  );
  // Behind the fold a tool's reason is said once, as the tool's own line,
  // and each row says what a tap does; two rows of one tool used to each
  // repeat the reason (#3075).
  const groups = scanToolsFoldGroups(hints, folded);
  useLockPageScroll();
  const sheetRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(true, sheetRef, onClose);
  return createPortal(
    <OverlayLayer ref={sheetRef} className="z-50 flex items-end bg-slate-900/50" onClick={onClose} role="presentation">
      <div
        role="menu"
        data-sheet
        aria-label={`Tools for ${title}`}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 pb-[max(0.5rem,var(--inset-bottom))] shadow-2xl"
      >
        <div className="truncate px-4 pt-3 pb-1 text-[11px] uppercase tracking-widest text-faint">{title}</div>
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
              More tools{foldLabel && <span className="text-xs">({foldLabel})</span>}
            </button>
            {moreOpen &&
              groups.map((g) => (
                <div key={g.key} data-tool-group={g.key}>
                  {g.reason && <p className="px-4 pt-2 text-xs text-faint">{g.reason}</p>}
                  {g.actions.map(row)}
                </div>
              ))}
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
