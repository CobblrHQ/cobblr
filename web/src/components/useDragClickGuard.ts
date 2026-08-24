// The click after a drag is not yours.
//
// Reordering the sidebar opened the item you were moving. Two things had to be
// true at once, and fixing either alone left it broken:
//
//   1. A press and a drag began identically. SidebarNav now arms dragging on a
//      HOLD, so a quick press-and-move is never a drag and stays the click it
//      looks like. That is upstream of this file.
//
//   2. A drag that ends WITHOUT REORDERING still produces a click. Drop a row
//      back where it started, or drag it past the end of the list so dnd-kit
//      cancels, and the browser dispatches a click on release like nothing
//      happened. dnd-kit suppresses that click after a drag it completed; it
//      does not after one that went nowhere.
//
// (2) is the reported case and it took a stable measurement to see. Dragging
// SIDEWAYS in a vertical list reorders nothing, so it behaved differently from
// run to run and read as random. Dragging the top item UP by one row fails
// every single time: the drop lands outside the list, the drag is cancelled,
// and the click opens the item. e2e/sidebar-drag-does-not-open.mjs pins that
// exact motion.
//
// THE LISTENER IS ON THE DOCUMENT, not the row. After a reorder the row has
// moved, so the click lands on whatever is now under the pointer — measured as
// <body>. A listener on the row would miss it.
//
// WHAT DOES NOT WORK, so the afternoon is not spent twice:
//
//   inferring from distance — a press and a drag start identically, so no
//     reading of the pointer separates them. Three variants of this either
//     missed the drag or swallowed legitimate clicks.
//   cancelling `dragstart` — an <a href> is natively draggable, and killing
//     that drag MEASURABLY MADE IT WORSE: the native link-drag was the thing
//     suppressing the click, so cancelling it let every drag navigate.
//   an onClickCapture prop — React never dispatches this click, so it never
//     ran. NavLink's own onClick does not run either, which is why the browser
//     falls back to following the href.

import { useEffect, useRef } from "react";

/** How long a finished drag may wait for its click before the guard disarms. A
 *  drag can end without producing one, and a guard left armed would eat
 *  somebody else's next click. */
const CLICK_GRACE_MS = 300;

export function useDragClickGuard(isDragging: boolean): void {
  const wasDragging = useRef(false);

  useEffect(() => {
    if (isDragging) {
      wasDragging.current = true;
      return;
    }
    // Only the true → false edge arms it, so a click that never involved a drag
    // is never touched. That is the whole difference from the distance-based
    // attempts, which had to guess and sometimes guessed a real click.
    if (!wasDragging.current) return;
    wasDragging.current = false;

    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", onClick, true);
    };
    function onClick(e: Event) {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
    document.addEventListener("click", onClick, true);
    timer = window.setTimeout(cleanup, CLICK_GRACE_MS);
    return cleanup;
  }, [isDragging]);
}
