// The bottom dock: bottom-anchored chrome that knows about its neighbours.
//
// Before this, each piece of bottom chrome paid for itself and offset the one
// piece it happened to know about: the workspace strip published its own
// height, the feedback bubble read that one variable, the toasts read the
// bubble's, and the next piece would have read none of them (core #3016).
//
// Now every anchor="bottom" FloatingChrome registers here. The dock stacks the
// members in registration order, first at the very bottom, and publishes ONE
// number, --bottom-chrome-height, the sum of the members that are visible. The
// body pays it once as padding, so the last row of any page clears the chrome;
// corner pieces (the bubble, the Live pill, toasts) sit above it through the
// same variable. A member that hides (an overlay opened and it yields, or it
// unmounted) drops out of the sum on the next layout.

/** The rule, pure so it can be held without a browser: given each member's
 *  visible height in registration order, where does each one sit and how much
 *  room do they take? A hidden member (height 0) sits where it would be and
 *  costs nothing. */
export function stackBottomChrome(heights: readonly number[]): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let total = 0;
  for (const h of heights) {
    offsets.push(total);
    if (h > 0) total += h;
  }
  return { offsets, total };
}

export const BOTTOM_CHROME_HEIGHT_VAR = "--bottom-chrome-height";
/** Set on each member: where the dock put it. */
export const MEMBER_BOTTOM_VAR = "--fc-bottom";

type Member = { el: HTMLElement; order: number };
const members = new Map<HTMLElement, Member>();
let seq = 0;
let frame = 0;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;

/** How tall a member is right now; 0 when it is display:none (the overlay flag
 *  hid it) or gone. The laid-out box, fractional, which is what the page has
 *  to clear. */
function heightOf(el: HTMLElement): number {
  return el.isConnected ? el.getBoundingClientRect().height : 0;
}

function layout(): void {
  frame = 0;
  const list = [...members.values()].sort((a, b) => a.order - b.order);
  const { offsets, total } = stackBottomChrome(list.map((m) => heightOf(m.el)));
  list.forEach((m, i) => m.el.style.setProperty(MEMBER_BOTTOM_VAR, `${offsets[i]}px`));
  const root = document.documentElement;
  if (total > 0) root.style.setProperty(BOTTOM_CHROME_HEIGHT_VAR, `${total}px`);
  else root.style.removeProperty(BOTTOM_CHROME_HEIGHT_VAR);
  document.body.style.paddingBottom = total > 0 ? `${total}px` : "";
}

/** Coalesced: a burst of resizes is one layout. */
export function scheduleDockLayout(): void {
  if (frame) return;
  frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(layout) : (setTimeout(layout, 0) as unknown as number);
}

function ensureObservers(): void {
  if (!ro && typeof ResizeObserver !== "undefined") ro = new ResizeObserver(scheduleDockLayout);
  // The overlay flag flips display on yielding members; ResizeObserver reports
  // the box going to 0, and this catches the same moment without waiting on it.
  if (!mo && typeof MutationObserver !== "undefined") {
    mo = new MutationObserver(scheduleDockLayout);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-overlay-open"] });
  }
}

/** Join the dock. Returns the leave function. */
export function registerBottomChrome(el: HTMLElement): () => void {
  ensureObservers();
  members.set(el, { el, order: seq++ });
  ro?.observe(el);
  scheduleDockLayout();
  return () => {
    members.delete(el);
    ro?.unobserve(el);
    el.style.removeProperty(MEMBER_BOTTOM_VAR);
    scheduleDockLayout();
  };
}

/** For tests: lay out now, synchronously. A frame already scheduled runs the
 *  same idempotent layout again, so nothing is cancelled. */
export function layoutDockNow(): void {
  layout();
}
