// Focus that loses its element finds the row now in its place (#4115).
//
// A row's Remove button goes with its row. Focus was on it, so it fell to the
// page itself, and a keyboard or screen reader user was sent back to the top to
// find their place again from the first control (a list's line removed, walked
// on an iPhone). Every list that removes its own rows had it. So the shell
// remembers where focus is: each ancestor and the place of the one below it.
// When that element leaves the page and focus is nowhere, the deepest
// ancestor still on the page says where the removed part was, and focus goes
// to the row now in its place, else the one before it, else that ancestor.
// It waits a frame, so a dialog that hands focus back to the button that
// opened it (useDialogFocus) does that first; it never moves focus a person
// has already moved, never reaches into what hangs off the body (another
// dialog's layer), and leaves a new page's focus to the page (RouteAnnouncer).

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface FocusPlace {
  el: Element;
  /** Each ancestor up to the body, with the place of the one below it among
   *  its children: whatever part of it is removed, the deepest ancestor still
   *  on the page says where the removed part was. */
  path: Array<{ parent: Element; child: Element; index: number }>;
  /** The page it was on: after a page change, focus is the new page's. */
  href: string;
}

/** Where an element is, as each ancestor and the child's place in it. */
export function placeOf(el: Element): FocusPlace {
  const path: FocusPlace["path"] = [];
  let child: Element = el;
  while (child.parentElement && child !== document.body) {
    const parent = child.parentElement;
    path.push({ parent, child, index: Array.prototype.indexOf.call(parent.children, child) });
    child = parent;
  }
  return { el, path, href: typeof location === "undefined" ? "" : location.href };
}

function shown(el: Element): boolean {
  const h = el as HTMLElement;
  if (typeof h.checkVisibility === "function") return h.checkVisibility();
  return h.getClientRects().length > 0 || !!h.offsetParent;
}

function firstFocusable(row: Element): HTMLElement | null {
  if (row.matches(FOCUSABLE) && shown(row)) return row as HTMLElement;
  return [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].find(shown) ?? null;
}

/** Where focus should go once `place.el` has left the page. The deepest
 *  ancestor still on the page lost a child at a known place: the row now at
 *  that place, else the one before, else that ancestor itself. Null when
 *  nothing there can take focus. */
export function rescueTarget(place: FocusPlace): HTMLElement | null {
  const at = place.path.find((p) => p.parent.isConnected && !p.child.isConnected);
  if (!at || at.parent === document.body) return null;
  const rows = at.parent.children;
  for (const i of [at.index, at.index - 1]) {
    const row = i >= 0 ? rows[i] : undefined;
    const target = row ? firstFocusable(row) : null;
    if (target) return target;
  }
  const holder = at.parent as HTMLElement;
  if (!shown(holder)) return null;
  if (!holder.hasAttribute("tabindex")) holder.setAttribute("tabindex", "-1");
  return holder;
}

const nowhere = () => !document.activeElement || document.activeElement === document.body || document.activeElement === document.documentElement;

/** Watch the page: when the focused element is removed and focus is left on
 *  nothing, move it to the row in its place. Returns how to stop. */
export function installFocusRescue(): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  let last: FocusPlace | null = null;
  let frame = 0;
  const onFocusIn = (e: FocusEvent) => {
    if (e.target instanceof Element && e.target !== document.body) last = placeOf(e.target);
  };
  const check = () => {
    frame = 0;
    const place = last;
    if (!place || place.el.isConnected || !nowhere() || place.href !== location.href) return;
    last = null;
    rescueTarget(place)?.focus({ preventScroll: false });
  };
  const mo = new MutationObserver(() => {
    if (last && !last.el.isConnected && !frame) frame = requestAnimationFrame(check);
  });
  document.addEventListener("focusin", onFocusIn);
  mo.observe(document.body, { childList: true, subtree: true });
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    mo.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
