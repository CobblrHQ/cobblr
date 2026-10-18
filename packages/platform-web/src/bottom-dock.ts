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

/** Where each corner piece sits in its corner's stack, bottom first. Declared
 *  here, in one list, so two pieces can never both claim the corner and a new
 *  piece has to say where it goes. The Live pill once sat on the feedback
 *  bubble on a phone because each piece only knew its own lift (#4390). */
export const CORNER_STACK = {
  feedback: 10,
  live: 20,
  labels: 30,
  /** The scan scope a scanner is scanning within (#6892). */
  scanScope: 35,
  quickAccess: 40,
  backToTop: 50,
  /** The bar of actions for a selection, centred across the bottom: its own
   *  corner, so it stacks only with anything else centred. */
  selectionBar: 60,
  toasts: 90,
} as const;
/** The breath between two stacked corner pieces, in px. */
export const CORNER_GAP = 8;

export type CornerSide = "left" | "centre" | "right";

/** The rule, pure: the pieces in one corner, each with its order, its own
 *  lift and its height. The lowest order sits at its lift; every next one
 *  sits on top of the one below it, a gap above. A hidden piece (height 0)
 *  takes no room. Returns each piece's extra offset over its own lift (what
 *  --fc-stack carries) and the stack's top. Ties keep the order given. */
export function stackCorner(pieces: readonly { order: number; lift: number; height: number }[]): { offsets: number[]; top: number } {
  const idx = pieces.map((_, i) => i).sort((a, b) => pieces[a]!.order - pieces[b]!.order || a - b);
  const offsets = new Array<number>(pieces.length).fill(0);
  let next: number | null = null;
  for (const i of idx) {
    const p = pieces[i]!;
    if (p.height <= 0) continue;
    const bottom: number = next === null ? p.lift : Math.max(p.lift, next);
    offsets[i] = bottom - p.lift;
    next = bottom + p.height + CORNER_GAP;
  }
  return { offsets, top: next === null ? 0 : next - CORNER_GAP };
}

/** Which corner a piece is in, from where it is drawn: a pill hugging the
 *  right edge, the left, or a bar centred across the bottom. */
export function cornerSide(rect: { left: number; right: number }, viewportWidth: number): CornerSide {
  const centre = (rect.left + rect.right) / 2;
  if (centre > viewportWidth * 0.6) return "right";
  if (centre < viewportWidth * 0.4) return "left";
  return "centre";
}

/** The room the overlays leave at the foot of the screen: from the screen's
 *  bottom edge to the top of the tallest corner piece that stays up over an
 *  overlay (the toasts), plus a gap. A piece that stays visible over a modal
 *  must not sit on the modal's buttons, so the modal ends above it instead.
 *  The Groceries install toast sat on the new item form's Create, the plan
 *  import toast on Cancel, and the update notice on the phone menu's links
 *  (#5801). A hidden piece (height 0) takes no room. */
export function overlayBottomReserve(viewportHeight: number, pieces: readonly { top: number; height: number }[]): number {
  let reserve = 0;
  for (const p of pieces) if (p.height > 0) reserve = Math.max(reserve, viewportHeight - p.top + CORNER_GAP);
  return Math.max(0, Math.ceil(reserve));
}

export const CORNER_STACK_VAR = "--fc-stack";

export const BOTTOM_CHROME_HEIGHT_VAR = "--bottom-chrome-height";
/** The room the page's end reserves: the bars plus the tallest corner piece. */
export const BOTTOM_CLEARANCE_VAR = "--bottom-chrome-clearance";
/** What every overlay leaves free at its foot (overlayBottomReserve). */
export const OVERLAY_BOTTOM_VAR = "--overlay-bottom";
/** Set on each member: where the dock put it. */
export const MEMBER_BOTTOM_VAR = "--fc-bottom";

type Member = { el: HTMLElement; order: number };
const members = new Map<HTMLElement, Member>();
const corners = new Map<HTMLElement, number>();
/** Corner pieces that stay up while an overlay is open (yields={false}). */
const overOverlays = new Set<HTMLElement>();
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
  // The lowest bar that shows sits on the home bar's inset and paints it in
  // its own colour (floating-chrome.css); the dock starts above the inset.
  const edge = list.find((m) => heightOf(m.el) > 0)?.el;
  for (const m of list) {
    if (m.el === edge) m.el.setAttribute("data-fc-edge", "");
    else m.el.removeAttribute("data-fc-edge");
  }
  const root = document.documentElement;
  if (total > 0) root.style.setProperty(BOTTOM_CHROME_HEIGHT_VAR, `${total}px`);
  else root.style.removeProperty(BOTTOM_CHROME_HEIGHT_VAR);
  // Each corner is one stack: the pieces on the same side sit one above the
  // other in CORNER_STACK order, never on each other. A corner piece that
  // yields to content is translucent over a control; a hidden one (the
  // overlay flag) is display:none and measures 0, and takes no room.
  const vw = root.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0);
  const sides = new Map<CornerSide, Array<{ el: HTMLElement; order: number; lift: number; height: number }>>();
  for (const [el, order] of corners) {
    const side = cornerSide(el.getBoundingClientRect(), vw);
    const list = sides.get(side) ?? [];
    list.push({ el, order, lift: liftOf(el), height: heightOf(el) });
    sides.set(side, list);
  }
  const stacked: Array<{ height: number; lift: number }> = [];
  for (const list of sides.values()) {
    const { offsets } = stackCorner(list);
    list.forEach((p, i) => {
      const off = offsets[i] ?? 0;
      if (off > 0) p.el.style.setProperty(CORNER_STACK_VAR, `${off}px`);
      else p.el.style.removeProperty(CORNER_STACK_VAR);
      stacked.push({ height: p.height, lift: p.lift + off });
    });
  }
  const clearance = bottomClearance(total, stacked);
  if (clearance > 0) root.style.setProperty(BOTTOM_CLEARANCE_VAR, `${clearance}px`);
  else root.style.removeProperty(BOTTOM_CLEARANCE_VAR);
  document.body.style.paddingBottom = clearance > 0 ? `calc(var(--inset-bottom, 0px) + ${clearance}px)` : "";
  // Measured after the stacking above, so the rect is where the piece now is.
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const reserve = overlayBottomReserve(vh, [...overOverlays].map((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, height: el.isConnected ? r.height : 0 };
  }));
  if (reserve > 0) root.style.setProperty(OVERLAY_BOTTOM_VAR, `${reserve}px`);
  else root.style.removeProperty(OVERLAY_BOTTOM_VAR);
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
    el.removeAttribute("data-fc-edge");
    scheduleDockLayout();
  };
}

/** A corner piece joins its corner's stack (CORNER_STACK order) and the
 *  clearance the page's end reserves. One that stays up over an overlay
 *  (`overOverlays`) also sets the room every overlay leaves at its foot.
 *  Returns the leave function. */
export function registerCornerChrome(el: HTMLElement, order: number = CORNER_STACK.toasts - 1, opts: { overOverlays?: boolean } = {}): () => void {
  ensureObservers();
  corners.set(el, order);
  if (opts.overOverlays) overOverlays.add(el);
  ro?.observe(el);
  scheduleDockLayout();
  return () => {
    corners.delete(el);
    overOverlays.delete(el);
    ro?.unobserve(el);
    el.style.removeProperty(CORNER_STACK_VAR);
    scheduleDockLayout();
  };
}

/** For tests: lay out now, synchronously. A frame already scheduled runs the
 *  same idempotent layout again, so nothing is cancelled. */
export function layoutDockNow(): void {
  layout();
}
