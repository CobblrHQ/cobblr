// Chrome that floats over the page: one primitive owns `position: fixed`.
//
// Thirty-two files spelled `fixed` by hand, and four of them yielded to an
// open overlay. The sandbox strip covered the camera's shutter on a phone;
// before it the Live pill sat on Ask Cobb's send button and the feedback bubble
// on a scan card's Confirm. Each fix was pairwise: this piece reads that one's
// height, the next piece reads nothing (core #3012, #3016).
//
// So chrome says what it is and the primitive does the rest:
//
//   anchor="top"     a bar across the top (a banner, the shell's header).
//   anchor="bottom"  a bar across the bottom. Joins the DOCK (bottom-dock.ts):
//                    stacked with its neighbours, and the page pays for the
//                    stack once.
//   anchor="corner"  a pill or bubble: sits above the dock's height, with its
//                    own `lift`. Horizontal placement is the caller's
//                    (right-4, or left-1/2 -translate-x-1/2 for a centred bar).
//
//   yields (default true)   hides while any overlay is open, through the one
//                           flag every Modal, SidePanel, sheet and full-screen
//                           surface raises (overlay-open.ts). A toast stack or
//                           a connectivity banner says yields={false}.
//   yieldToContent          a corner piece that must not sit on something you
//                           can press (yield-to-content.ts): translucent and
//                           click-through while it covers a control.
//
// It portals to <body>: an ancestor's backdrop-blur or transform would
// otherwise become the containing block and the chrome would scroll away with
// the page. z-index stays with the piece (a banner over the header is z-200; a
// pill is z-40), passed in className like any other class.
//
// lint:fixed-chrome refuses a bare `fixed` outside this package, so this, the
// layers beside it (fixed-layers.tsx), Modal and SidePanel are the only ways to
// express one.

import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties, type ElementType, type HTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HIDE_WHEN_OVERLAY_OPEN } from "./overlay-open";
import { registerBottomChrome } from "./bottom-dock";
import { useYieldToContent, YIELDING_CLASS } from "./yield-to-content";

export type FloatingAnchor = "top" | "bottom" | "corner";

/** Any attribute the rendered tag takes (a button's `type`, a header's role):
 *  the tag is the caller's, so its attributes are too. */
export interface FloatingChromeProps extends HTMLAttributes<HTMLElement>, Record<`data-${string}`, string | number | boolean | undefined> {
  type?: string;
  disabled?: boolean;
  anchor: FloatingAnchor;
  /** Hide while an overlay is open. Default true. */
  yields?: boolean;
  /** Corner pieces: go translucent and click-through over a pressable control. */
  yieldToContent?: boolean;
  /** Corner pieces: the breath above the dock's edge. Any CSS length; default 1rem. */
  lift?: string;
  /** The element to render. Default "div". */
  as?: ElementType;
  /** Render in place instead of portaling to body: for a piece that is itself
   *  the shell (the app header sits in the layout's grid so its spacer and
   *  its measurement stay next to it). */
  inPlace?: boolean;
  children?: ReactNode;
}

export const FloatingChrome = forwardRef<HTMLElement, FloatingChromeProps>(function FloatingChrome(
  { anchor, yields = true, yieldToContent = false, lift, as: Tag = "div", inPlace = false, className = "", style, children, ...rest },
  ref,
) {
  const inner = useRef<HTMLElement | null>(null);
  // A stable empty ref for the pieces that do not yield to content: the hook
  // re-subscribes on ref identity, so a fresh object here would do that every
  // render.
  const never = useRef<HTMLElement | null>(null);
  useImperativeHandle(ref, () => inner.current as HTMLElement, []);
  const covering = useYieldToContent(yieldToContent ? inner : never);

  useEffect(() => {
    if (anchor !== "bottom" || !inner.current) return;
    return registerBottomChrome(inner.current);
  }, [anchor]);

  const cls =
    "fc-fixed " +
    (anchor === "top" ? "fc-top " : anchor === "bottom" ? "fc-bottom " : "fc-corner ") +
    (yields ? HIDE_WHEN_OVERLAY_OPEN + " " : "") +
    (covering ? YIELDING_CLASS + " " : "") +
    className;
  const merged: CSSProperties & Record<string, string | number | undefined> = { ...(style as CSSProperties) };
  if (anchor === "corner" && lift) merged["--fc-lift"] = lift;

  const node = (
    <Tag ref={inner} className={cls} style={merged} {...rest}>
      {children}
    </Tag>
  );
  if (inPlace || typeof document === "undefined") return node;
  return createPortal(node, document.body);
});
