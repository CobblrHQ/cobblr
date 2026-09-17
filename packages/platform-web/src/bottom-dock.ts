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

/** What the page's end must clear: the dock's bars, plus the tallest corner
 *  piece sitting above them (its lift and its own height). A corner piece
 *  goes translucent over a control it covers (yield-to-content.ts), but a
 *  page whose last row can never scroll clear of the Live pill and the
 *  bubble still has actions nobody can read whole (#3069). A hidden corner
 *  piece (height 0) costs nothing. */
export function bottomClearance(barTotal: number, corners: readonly { height: number; lift: number }[]): number {
  let tallest = 0;
  for (const c of corners) if (c.height > 0) tallest = Math.max(tallest, c.height + c.lift);
  return barTotal + tallest;
}

export const BOTTOM_CHROME_HEIGHT_VAR = "--bottom-chrome-height";
/** The room the page's end reserves: the bars plus the tallest corner piece. */
export const BOTTOM_CLEARANCE_VAR = "--bottom-chrome-clearance";
/** Set on each member: where the dock put it. */
export const MEMBER_BOTTOM_VAR = "--fc-bottom";

type Member = { el: HTMLElement; order: number };
const members = new Map<HTMLElement, Member>();
const corners = new Set<HTMLElement>();
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

/** A corner piece's lift above the dock, in px, as the browser resolved it
 *  (its --fc-lift, default 1rem). */
function liftOf(el: HTMLElement): number {
  const v = getComputedStyle(el).getPropertyValue("--fc-lift").trim();
  if (!v) return 16;
  if (v.endsWith("rem")) return parseFloat(v) * parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
  if (v.endsWith("px")) return parseFloat(v);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 16;
}

function layout(): void {
  frame = 0;
  const list = [...members.values()].sort((a, b) => a.order - b.order);
  const { offsets, total } = stackBottomChrome(list.map((m) => heightOf(m.el)));
  list.forEach((m, i) => m.el.style.setProperty(MEMBER_BOTTOM_VAR, `${offsets[i]}px`));
  const root = document.documentElement;
  if (total > 0) root.style.setProperty(BOTTOM_CHROME_HEIGHT_VAR, `${total}px`);
  else root.style.removeProperty(BOTTOM_CHROME_HEIGHT_VAR);
  // A corner piece that yields to content is translucent over a control; a
  // hidden one (the overlay flag) is display:none and measures 0.
  const clearance = bottomClearance(total, [...corners].map((el) => ({ height: heightOf(el), lift: liftOf(el) })));
  if (clearance > 0) root.style.setProperty(BOTTOM_CLEARANCE_VAR, `${clearance}px`);
  else root.style.removeProperty(BOTTOM_CLEARANCE_VAR);
  document.body.style.paddingBottom = clearance > 0 ? `${clearance}px` : "";
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

/** A corner piece joins the clearance the page's end reserves (it does not
 *  stack). Returns the leave function. */
export function registerCornerChrome(el: HTMLElement): () => void {
  ensureObservers();
  corners.add(el);
  ro?.observe(el);
  scheduleDockLayout();
  return () => {
    corners.delete(el);
    ro?.unobserve(el);
    scheduleDockLayout();
  };
}

/** For tests: lay out now, synchronously. A frame already scheduled runs the
 *  same idempotent layout again, so nothing is cancelled. */
export function layoutDockNow(): void {
  layout();
}
