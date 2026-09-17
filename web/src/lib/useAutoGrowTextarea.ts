// A textarea that is as tall as what it holds, up to a cap, and shrinks
// back. One rule for every free-text box that grows with typing (the chat
// input, the scan hint), so none of them clips its own placeholder or its
// third line behind a fixed `rows` (#3018).
//
// Height is set in a LAYOUT effect, synchronously with the commit that
// rendered the new value, so the box never paints a frame at the old height
// and then jumps; a frame callback would (the chat input learned that with
// its caret, and forbids one).
import { useLayoutEffect, type RefObject } from "react";

/** Fit `el` to its content, at most `maxPx` tall (then it scrolls).
 *
 *  scrollHeight is the content box plus padding; `height` under the
 *  border-box sizing every control here carries also has to hold the
 *  borders, or the box comes up short by exactly their width and the last
 *  line's descenders are cut. A 1px border either side clipped the scan
 *  hint's placeholder by 2px on Chromium (WebKit rounds the other way and
 *  hid it), which is how the lane's phone run went red on a check that was
 *  green on the lab's WebKit. */
export function growToContent(el: HTMLTextAreaElement, maxPx: number): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight + verticalBorderPx(el), maxPx)}px`;
}

function verticalBorderPx(el: HTMLElement): number {
  if (typeof getComputedStyle !== "function") return 0;
  const cs = getComputedStyle(el);
  if (cs.boxSizing !== "border-box") return 0;
  return (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
}

/** Keep the textarea in `ref` fitted to `value` as it changes. */
export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx = 200): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) growToContent(el, maxPx);
  }, [ref, value, maxPx]);
}
