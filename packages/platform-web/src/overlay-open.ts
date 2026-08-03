// "Is an overlay covering the page right now?" — one flag, so floating chrome
// can get out of the way.
//
// The Live pill sits at z-900 and Quick access at z-80, both far above a modal
// (z-50) and the side panels (z-60), so they floated ON TOP of whatever overlay
// was open: over Ask Cobb's message box, and over the bottom of every modal on
// a phone (the author, 2026-08-01). Fixed first for the side panels, then reported
// again for modals — so the flag lives here, in the package that owns Modal,
// and every overlay sets it.
//
// It's a COUNTER, not a boolean: a modal opened on top of another modal (or of
// a side panel) must not clear the flag when the inner one closes.

import { useLayoutEffect } from "react";

/** Put this on any FLOATING chrome that out-stacks overlays, so it yields while
 *  one is open. `lint:floating-chrome` fails CI on high-z bottom-anchored
 *  chrome that skips it. */
export const HIDE_WHEN_OVERLAY_OPEN = "[[data-overlay-open]_&]:hidden";

let openOverlays = 0;

/** Declarative form: drop `<OverlayFlag />` INSIDE the overlay's own layer.
 *  Mounting is then the condition — no `open &&` to thread through, no hook
 *  ordering to get wrong in a component that early-returns null when closed,
 *  and it sits next to the markup it describes. Preferred over calling the
 *  hook by hand unless the overlay is a whole page (the scanner). */
export function OverlayFlag(): null {
  useOverlayOpenFlag();
  return null;
}

/** Call from any overlay while it is mounted/open. */
export function useOverlayOpenFlag(active = true): void {
  useLayoutEffect(() => {
    if (!active) return;
    openOverlays += 1;
    document.documentElement.setAttribute("data-overlay-open", "1");
    return () => {
      openOverlays -= 1;
      if (openOverlays <= 0) {
        openOverlays = 0;
        document.documentElement.removeAttribute("data-overlay-open");
      }
    };
  }, [active]);
}
