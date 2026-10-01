// "Is an overlay covering the page right now?" — one flag, so floating chrome
// can get out of the way.
//
// The Live pill sits at z-900 and Quick access at z-80, both far above a modal
// (z-50) and the side panels (z-60), so they floated ON TOP of whatever overlay
// was open: over Ask Cobb's message box, and over the bottom of every modal on
// a phone (reported 2026-08-01). Fixed first for the side panels, then reported
// again for modals — so the flag lives here, in the package that owns Modal,
// and every overlay sets it.
//
// It's a COUNTER, not a boolean: a modal opened on top of another modal (or of
// a side panel) must not clear the flag when the inner one closes.

import { useLayoutEffect } from "react";

/** Put this on any FLOATING chrome that out-stacks overlays, so it yields while
 *  one is open. FloatingChrome mixes it in by default; lint:fixed-chrome
 *  refuses a bare `fixed` outside this package, so no chrome misses it. */
export const HIDE_WHEN_OVERLAY_OPEN = "[[data-overlay-open]_&]:hidden";

/** For chrome that lives in the page's content column and so need not hide
 *  for a side panel docked beside it on a desk (the selection bar, #4531):
 *  it hides for an overlay that COVERS the page (a modal, a sheet), and on a
 *  phone, where a side panel covers the page too. floating-chrome.css. */
export const HIDE_WHEN_COVERED = "fc-yield-covered";

let openOverlays = 0;
let coveringOverlays = 0;

/** Declarative form: drop `<OverlayFlag />` INSIDE the overlay's own layer.
 *  Mounting is then the condition — no `open &&` to thread through, no hook
 *  ordering to get wrong in a component that early-returns null when closed,
 *  and it sits next to the markup it describes. Preferred over calling the
 *  hook by hand unless the overlay is a whole page (the scanner). */
export function OverlayFlag(): null {
  useOverlayOpenFlag();
  return null;
}

/** Call from any overlay while it is mounted/open. A side panel says
 *  `side`: on a desk it sits beside the page rather than over it, so chrome
 *  in the content column (HIDE_WHEN_COVERED) stays; every other overlay
 *  covers the page. */
export function useOverlayOpenFlag(active = true, kind: "covering" | "side" = "covering"): void {
  useLayoutEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    openOverlays += 1;
    root.setAttribute("data-overlay-open", "1");
    if (kind === "covering") {
      coveringOverlays += 1;
      root.setAttribute("data-covering-open", "1");
    }
    return () => {
      openOverlays -= 1;
      if (openOverlays <= 0) {
        openOverlays = 0;
        root.removeAttribute("data-overlay-open");
      }
      if (kind === "covering") {
        coveringOverlays -= 1;
        if (coveringOverlays <= 0) {
          coveringOverlays = 0;
          root.removeAttribute("data-covering-open");
        }
      }
    };
  }, [active, kind]);
}
