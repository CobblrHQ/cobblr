// Catching a highlight before the browser throws it away — and keeping it
// visible, and turning it back into the record it names.
//
// Three things go wrong with a plain document selection:
//
//   1. It is GONE the moment the caret enters the chat box, which is exactly
//      when it was about to be useful. So it is captured as it happens.
//   2. It stops being VISIBLE at the same moment, so there is nothing on screen
//      saying what "these" refers to. The range is re-painted with the Custom
//      Highlight API, which does not depend on focus.
//   3. It is only a STRING. Highlighting "Rack 1" and asking to delete
//      duplicates got "there's only one location named Rack 1" — true, and
//      useless, because the duplicates were the two Shelf 1s inside it. A page
//      can say which record those words are, and then Cobb works on the thing.

import { useEffect } from "react";
import {
  publishTextSelection,
  resolveSelectionText,
  subscribeChatSelection,
  getChatSelection,
} from "./chat-context";

/** Drop only the captured HIGHLIGHT — ticked rows belong to the page. */
function clearTextSelection(): void {
  publishTextSelection(null);
}

/** Long enough to be deliberate, short enough to include "Rack 1". */
const MIN_CHARS = 3;
const MAX_CHARS = 2000;
const PAINT = "cobb-selection";

/** Chrome/Edge have the Custom Highlight API; Safari and Firefox are catching
 *  up. Where it is missing the chip still says what is in context — the paint
 *  is the nicety, not the mechanism. */
function paint(range: Range | null): void {
  const api = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Ctor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!api || !Ctor) return;
  if (!range) {
    api.delete(PAINT);
    return;
  }
  api.set(PAINT, new Ctor(range));
}

export function useSelectionCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return; // NOT cleared: see below
      const node = sel.anchorNode;
      const el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
      // A selection inside the chat panel is someone reading Cobb's own words
      // back, not pointing at their workspace.
      if (el?.closest("[data-cobb-panel]")) return;
      const text = sel.toString().trim().slice(0, MAX_CHARS);
      if (text.length < MIN_CHARS) return;
      paint(sel.getRangeAt(0).cloneRange());
      const record = resolveSelectionText(text);
      publishTextSelection(
        record
          ? { label: record.label, kind: record.kind, ids: [record.id], text }
          : { label: "Selected text", text },
      );
    };
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 150);
    };
    // Clicking nowhere in particular drops it. That is what a click on empty
    // space means everywhere else, and a highlight you cannot get rid of by
    // clicking off it is a highlight that has stopped being yours. Clicking
    // INTO the panel is exempt: that is someone going to type about the thing,
    // which is the whole point of keeping it.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-cobb-panel]")) return;
      // A click that starts a new selection is handled by selectionchange a
      // moment later; this only clears when the click lands on nothing.
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) clearTextSelection();
      }, 60);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("selectionchange", onChange);
    // The paint follows the chip: dismiss the one and the other goes with it.
    const off = subscribeChatSelection(() => {
      if (!getChatSelection()) paint(null);
    });
    return () => {
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("mousedown", onDown);
      off();
      paint(null);
      if (timer) clearTimeout(timer);
    };
    // A collapsed selection on its own deliberately does NOT clear what was
    // captured: the collapse is usually the click into the chat box, which is
    // the moment the user is about to ask about the thing they just
    // highlighted. Only a click that lands OUTSIDE the panel on nothing does.
  }, [active]);
}
