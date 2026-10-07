// Sticky bottom bar for a list page's multi-select.
//
// Two things learned the hard way live here.
//
// It rendered NOTHING until a row was ticked, which hid the feature behind an
// unlabelled checkbox. The fix attempted first — an idle strip reading "Tick
// rows to print labels or delete" — replaced a hidden feature with a permanent
// piece of furniture on an empty page, which is worse: it is on screen always
// and useful once. The bar stays silent again; discoverability belongs to the
// checkbox column, not to a line of standing text.
//
// And ticking rows used to hand the selection to the assistant as a side
// effect, so printing labels for two racks silently made them the subject of
// your next message and lit their Cobb buttons. A checkbox and the Cobb button
// are different instructions: "do this to these" versus "let us talk about
// this". Cobb is one of the ACTIONS here now, so pointing him at a selection is
// something you ask for.

import { SendRecords } from "./SendRecords";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { MessageSquare, X } from "lucide-react";
import { usePlatformWeb } from "./context";
import { FloatingChrome } from "./FloatingChrome";
import { CORNER_STACK } from "./bottom-dock";
import { clearBarSelection } from "./chat-context";

interface Props {
  count: number;
  records?: { kind: string; ids: string[] };
  /** Action buttons to render between the count and the dismiss
   *  button. Each consumer page decides what actions make sense
   *  (delete / tag / move / etc.). */
  actions: ReactNode;
  onClear: () => void;
  /** Hand the ticked rows to Cobb. Null when the page has not wired it (or
   *  nothing is ticked); the button is simply absent. */
  onAskCobb?: (() => void) | null;
}

export function BulkActionBar({ count, actions, onClear, onAskCobb, records }: Props) {
  const { cobbIcon: Cobb } = usePlatformWeb();
  const actionsRef = useRef<HTMLDivElement>(null);
  const iconsOnly = useIconsBesidePanel(actionsRef, count > 0);
  const [sendOpen, setSendOpen] = useState(false);
  if (count === 0 && !sendOpen) return null;
  return (
    /* ONE line, always, clear of the floating chat button, and the CLOSE never
       moves.
       On a phone this grew to nearly the full width and every label broke in
       half ("2 / selected", "Print / labels", "Ask / Cobb"), and the right end
       ran under the chat bubble in the corner.
       The scroll is on the MIDDLE only. Wrapping the whole bar in overflow-x
       put the X inside the scrolling region, so on a narrow screen the one
       control that gets you out could scroll off the edge. The count and the X
       are pinned; only the actions between them slide. */
    <FloatingChrome
      style={count === 0 ? {display: "none"} : undefined}
      anchor="corner"
      stack={CORNER_STACK.selectionBar}
      lift="var(--bulk-bar-lift, 5rem)"
      // Stays beside a side panel on a desk (Ask Cobb from this bar opens
      // one), centred in what the panel leaves; it used to hide with every
      // overlay, so the selection seemed to vanish (#4531).
      yields="covering"
      className={(iconsOnly ? "fc-bar-icons " : "") + "left-[calc((100vw-var(--side-panel-w,0px))/2)] -translate-x-1/2 z-50 sm:[--bulk-bar-lift:1rem] flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 rounded-full border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg whitespace-nowrap max-w-[calc(100vw-var(--side-panel-w,0px)-1.5rem)]"}
      data-icons-only={iconsOnly || undefined}
    >
      {/* Just the number on a phone. "2 selected" spends a third of the bar
          saying what the checkboxes above already showed you; the number beside
          the actions is unambiguous. */}
      <span className="shrink-0 text-sm font-medium text-content dark:text-mortar-100">
        {count}
        <span className="hidden sm:inline fc-bar-words"> selected</span>
      </span>
      <span className="shrink-0 text-faint dark:text-slate-600">·</span>
      <div ref={actionsRef} className="flex min-w-0 items-center gap-1 sm:gap-2 overflow-x-auto no-scrollbar">
        {records && <SendRecords kind={records.kind} ids={records.ids} onDone={onClear} onOpenChange={setSendOpen} />}
        {actions}
        {onAskCobb && (
          <button
            type="button"
            onClick={onAskCobb}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-accent hover:text-accent"
            title="Put these in the chat, ready for your question"
          >
            {/* Cobb's own head, not a generic speech bubble: this is the one
                button in the app that hands your selection to HIM, and the head
                is how he is recognised everywhere else. Falls back to the
                bubble if a host has not supplied the mascot. */}
            {Cobb ? <Cobb size={14} /> : <MessageSquare size={12} />}
            <span className="fc-bar-words">Ask Cobb</span>
          </button>
        )}
      </div>
      <button
        onClick={() => {
          // The rows leave Cobb's chat too, if this bar put them there.
          clearBarSelection();
          onClear();
        }}
        className="shrink-0 text-faint hover:text-content dark:hover:text-mortar-100 transition p-1"
        title="Clear selection"
        aria-label="Clear selection"
      >
        <X size={14} />
      </button>
    </FloatingChrome>
  );
}

const NAMED_HERE = "data-fc-named";

/** Icons alone while a side panel leaves the bar too little room for its
 *  words, and the words back once there is room again (#4531). Only beside a
 *  panel: on a phone with no panel open the actions slide instead, because
 *  an icon with no word is a guess on a touch screen, where no tooltip shows.
 *
 *  The width the words need is the one measured when they last overflowed,
 *  so the bar does not flicker between the two at the edge. Each icon action
 *  is named while its words are hidden (aria-label, and a tooltip when it has
 *  none of its own), and those names leave again with the icons. */
function useIconsBesidePanel(ref: RefObject<HTMLDivElement | null>, shown: boolean): boolean {
  const [iconsOnly, setIconsOnly] = useState(false);
  const now = useRef(false);
  const needs = useRef(0);
  const check = useRef(() => {});
  check.current = () => {
    const el = ref.current;
    const bar = el?.parentElement;
    if (!el || !bar) return;
    const panel = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-panel-w")) || 0;
    let next: boolean;
    if (panel <= 0) next = false;
    else if (!now.current) {
      const over = el.scrollWidth - el.clientWidth;
      next = over > 0;
      if (next) needs.current = bar.getBoundingClientRect().width + over;
    } else next = window.innerWidth - panel - 24 < needs.current;
    if (next !== now.current) {
      now.current = next;
      setIconsOnly(next);
    }
  };

  // After every render: the actions a page hands in can change under the bar.
  useLayoutEffect(() => {
    if (shown) check.current();
  });

  useLayoutEffect(() => {
    if (!shown) return;
    const run = () => check.current();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(run);
    if (ref.current) ro?.observe(ref.current);
    // The side panel opening, closing or being resized says so on <html>.
    const mo = new MutationObserver(run);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", run);
    return () => {
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", run);
    };
  }, [ref, shown]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !iconsOnly) return;
    const named: HTMLElement[] = [];
    for (const b of el.querySelectorAll<HTMLElement>("button")) {
      if (!b.querySelector(":scope > svg, :scope > .fc-bar-words")) continue;
      const words = b.textContent?.trim();
      if (!words || b.hasAttribute("aria-label")) continue;
      b.setAttribute("aria-label", words);
      const tooltip = !b.title;
      if (tooltip) b.title = words;
      b.setAttribute(NAMED_HERE, tooltip ? "both" : "label");
      named.push(b);
    }
    return () => {
      for (const b of named) {
        if (b.getAttribute(NAMED_HERE) === "both") b.removeAttribute("title");
        b.removeAttribute("aria-label");
        b.removeAttribute(NAMED_HERE);
      }
    };
  });

  return iconsOnly;
}
