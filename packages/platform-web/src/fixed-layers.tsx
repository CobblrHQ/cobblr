// The other things that are `position: fixed` and are NOT chrome.
//
// An OverlayLayer covers the page (a sheet, a lightbox, the command palette,
// the phone menu). It raises the overlay flag itself, so every piece of
// floating chrome that yields gets out of its way: an overlay that forgot the
// flag is how the sandbox strip ended up over the camera's shutter.
//
// A PopoverLayer is a transient surface anchored to a trigger and positioned
// from a measured rect (a menu, the "more" fold, an account flyout). It closes
// on an outside click and takes no room, so the dock and the flag are not
// its business.
//
// A BackdropLayer is the invisible click-catcher a popover puts behind itself.
//
// Each spells the position through floating-chrome.css, and lint:fixed-chrome
// refuses a bare `fixed` outside this package, so an author reaching for one
// has to say which of these it is.

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties, type ForwardedRef, type HTMLAttributes, type ReactNode } from "react";
import { OverlayFlag } from "./overlay-open";
import { useLayerStack } from "./layer-stack";
import { useDialogFocus } from "./useDialogFocus";

/** This layer's own ref, forwarded to the caller's too. */
function useOwnRef(ref: ForwardedRef<HTMLDivElement>) {
  const own = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  return [own, setRef] as const;
}

export interface LayerProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  style?: CSSProperties;
}

export interface PopoverLayerProps extends LayerProps {
  /** The top edge of the trigger, in viewport pixels. Given, a popover that
   *  would run off the bottom opens above the trigger instead when it fits
   *  there, rather than being pushed up over the thing that opened it. */
  flipAbove?: number;
}

/** A surface that covers the page. Raises the overlay flag while mounted, and
 *  opens above any layer already open (layer-stack). Declared `aria-modal`, it
 *  is a dialog and holds the keyboard while it is up (useDialogFocus). */
export const OverlayLayer = forwardRef<HTMLDivElement, LayerProps>(function OverlayLayer({ className = "", children, ...rest }, ref) {
  const [own, setRef] = useOwnRef(ref);
  useLayerStack(own);
  const modal = rest["aria-modal"] === true || rest["aria-modal"] === "true";
  useDialogFocus(modal, own);
  return (
    <div ref={setRef} className={"fc-overlay " + className} {...rest}>
      <OverlayFlag />
      {children}
    </div>
  );
});

/** The screen's top and bottom safe area in px, as the page resolves the
 *  tokens (floating-chrome.css): 0 on a desk and in a browser tab. */
function screenInsets(): { insetTop: number; insetBottom: number } {
  const measure = (token: string) => {
    const probe = document.createElement("div");
    probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;left:0;top:0;width:0;height:var(${token},0px)`;
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  };
  return { insetTop: measure("--inset-top"), insetBottom: measure("--inset-bottom") };
}

/** The space every popover keeps from the screen's edges. */
export const POPOVER_GUTTER = 16;
const FLIP_GAP = 4;

/** Where a popover's box must move to sit on the screen: how far across and
 *  down, and the width it may take. Pure, so the rule is tested without a
 *  browser. A box wider than the screen less its gutters is narrowed to it; a
 *  box past the right or bottom edge moves back in; past the left or top, it
 *  moves out. With `flipAbove` (the trigger's top), a box past the bottom
 *  that fits above the trigger opens there instead. */
export function clampToViewport(
  box: { left: number; top: number; width: number; height: number },
  /** The screen, and the safe area its top and bottom keep (an iPhone's
   *  status bar and home bar, floating-chrome.css --inset-*): a popover
   *  stays clear of them as it does of the edges (#6551). */
  view: { width: number; height: number; insetTop?: number; insetBottom?: number },
  gutter = POPOVER_GUTTER,
  flipAbove?: number,
): { dx: number; dy: number; maxWidth: number | null } {
  const top = (view.insetTop ?? 0) + gutter;
  const bottom = view.height - (view.insetBottom ?? 0) - gutter;
  const room = view.width - gutter * 2;
  const width = Math.min(box.width, room);
  const maxWidth = box.width > room ? room : null;
  let dx = 0;
  if (box.left + width > view.width - gutter) dx = view.width - gutter - (box.left + width);
  if (box.left + dx < gutter) dx = gutter - box.left;
  let dy = 0;
  const pastBottom = box.top + box.height > bottom;
  if (pastBottom && flipAbove !== undefined && flipAbove - FLIP_GAP - box.height >= top) return { dx, dy: flipAbove - FLIP_GAP - box.height - box.top, maxWidth };
  if (pastBottom) dy = bottom - (box.top + box.height);
  if (box.top + dy < top) dy = top - box.top;
  return { dx, dy, maxWidth };
}

/** A transient surface anchored to a trigger; position it with `style`.
 *
 *  It keeps itself on the screen: whatever position its caller computed (and
 *  every caller computes its own, often from a width it assumed), the layer
 *  measures what it actually drew and moves back inside the viewport with a
 *  16px gutter, narrowing to the screen when it is wider. The scan card's
 *  File into menu assumed 288px and, in a phone's larger text, ran off the
 *  right edge (#3930); the fix is here, once, for every menu. */
export const PopoverLayer = forwardRef<HTMLDivElement, PopoverLayerProps>(function PopoverLayer({ className = "", children, flipAbove, ...rest }, ref) {
  const [own, setRef] = useOwnRef(ref);
  // Above the layer it opens from: a menu in a modal over the Ask Cobb panel.
  useLayerStack(own);
  // What this layer has already moved itself by, so a re-measure reads the
  // position its caller asked for rather than the corrected one.
  const applied = useRef({ dx: 0, dy: 0 });
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || typeof window === "undefined") return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const view = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight, ...screenInsets() };
      const asked = { left: r.left - applied.current.dx, top: r.top - applied.current.dy, width: r.width, height: r.height };
      const { dx, dy, maxWidth } = clampToViewport(asked, view, POPOVER_GUTTER, flipAbove);
      // Narrowing changes the size; the observer calls back once with the
      // new one. A move never does, so this cannot loop.
      if (maxWidth !== null && el.style.maxWidth !== `${maxWidth}px`) {
        el.style.maxWidth = `${maxWidth}px`;
        return;
      }
      if (dx !== applied.current.dx || dy !== applied.current.dy) {
        applied.current = { dx, dy };
        el.style.translate = dx || dy ? `${dx}px ${dy}px` : "";
      }
    };
    fit();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", fit);
    };
  });
  return (
    <div ref={setRef} className={"fc-popover " + className} {...rest}>
      {children}
    </div>
  );
});

/** The click-catcher behind a popover: covers the page, draws nothing. It
 *  goes above what is open, and its popover, rendered after it, above it. */
export const BackdropLayer = forwardRef<HTMLDivElement, LayerProps>(function BackdropLayer({ className = "", children, ...rest }, ref) {
  const [own, setRef] = useOwnRef(ref);
  useLayerStack(own);
  return (
    <div ref={setRef} className={"fc-backdrop " + className} {...rest}>
      {children}
    </div>
  );
});

/** Close an anchored layer when the PAGE scrolls under it (its position was
 *  measured once at open), never when its own list scrolls. A capture
 *  listener on window hears every element's scroll, the menu's own included:
 *  the scan card's File into menu closed on the first swipe through its
 *  tables, and the owner's next tap landed on Undo split under it (#6527). */
export function useCloseOnPageScroll(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Element && t.closest(`.${POPOVER_LAYER_CLASS}, .${OVERLAY_LAYER_CLASS}`)) return;
      latest.current();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [open]);
}

/** For a layer that must be a button (a keyboard-invisible click-catcher) or
 *  another tag: the class names, so the tag stays the caller's. */
export const OVERLAY_LAYER_CLASS = "fc-overlay";
export const POPOVER_LAYER_CLASS = "fc-popover";
export const BACKDROP_LAYER_CLASS = "fc-backdrop";
