// The one right-side overlay panel (Ask Cobb, Notifications). It exists to hold
// two rules in ONE place, both learned from the mobile bug where Ask Cobb sat
// shifted down with its composer below the fold (reported 2026-08-01):
//
//  1. NEVER size an overlay with `h-screen` / `100vh`. On iOS `100vh` is the
//     LARGE viewport (as if the toolbars were retracted), so the panel is
//     TALLER than what you can see and its bottom row is unreachable. Pin `top`
//     AND `bottom` instead — the box then tracks whatever is actually visible,
//     in the browser and in the standalone PWA alike. `lint:no-vh-overlays`
//     fails the build if a fixed overlay reaches for a viewport height again.
//  2. On a phone it is a full-width sheet that starts BELOW the app header, so
//     the navbar stays reachable and it doesn't read as a floating modal shoved
//     off-centre. `--app-header-bottom` is published live by AppLayout, so the
//     sheet follows the header as the env chip, banners and the safe-area inset
//     change its height.
//
// It portals to <body> so the header's backdrop-blur can't trap position:fixed
// (CLAUDE.md modal note).
import { useCallback, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { HIDE_WHEN_OVERLAY_OPEN, useLayerStack, useOverlayOpenFlag } from "@cobblr/platform-web";

/** Re-exported for the floating chrome that already imports it from here.
 *  The flag itself lives in platform-web now, because MODALS set it too. */
export const HIDE_WHEN_SIDE_PANEL_OPEN = HIDE_WHEN_OVERLAY_OPEN;


export function SidePanel({
  width,
  panelRef,
  escapeExempt = false,
  /** Marks this panel as the chat, so a highlight made INSIDE it is understood
   *  as reading Cobb's own words back rather than pointing at the workspace. */
  cobbPanel = false,
  children,
}: {
  /** Desktop width. Mobile is always full-bleed. */
  width: string;
  panelRef?: Ref<HTMLDivElement>;
  escapeExempt?: boolean;
  cobbPanel?: boolean;
  children: ReactNode;
}) {
  // Beside the page on a desk, over it on a phone: chrome in the content
  // column (the selection bar) stays beside it, re-centred in what is left
  // (--side-panel-w, published below), #4531.
  useOverlayOpenFlag(true, "side");
  // A modal or sheet opened from inside the panel goes above it (#3954).
  const own = useRef<HTMLDivElement | null>(null);
  useLayerStack(own);
  useLayoutEffect(() => {
    const el = own.current;
    const root = document.documentElement;
    if (!el) return;
    const publish = () => {
      const r = el.getBoundingClientRect();
      // Full-bleed on a phone: nothing is left beside it.
      const beside = r.left > 0 ? Math.round(window.innerWidth - r.left) : 0;
      root.style.setProperty("--side-panel-w", `${beside}px`);
    };
    publish();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--side-panel-w");
    };
  }, []);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      if (typeof panelRef === "function") panelRef(el);
      else if (panelRef) (panelRef as { current: HTMLDivElement | null }).current = el;
    },
    [panelRef],
  );
  return createPortal(
    <div
      ref={setRef}
      {...(escapeExempt ? { "data-modal-escape-exempt": true } : {})}
      {...(cobbPanel ? { "data-cobb-panel": true } : {})}
      className={
        "fixed inset-x-0 bottom-[var(--overlay-bottom,0px)] top-[var(--app-header-bottom,3.5rem)] z-[60] flex flex-col " +
        "border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl " +
        // Desktop: back to the familiar full-height drawer on the right edge.
        // top/bottom are overridden by NAME (not sm:inset-y-0) so the win over
        // top-[var(…)] doesn't depend on how Tailwind orders inset-* vs top-*.
        // The foot stops above the toasts at every width (--overlay-bottom,
        // floating-chrome.css), so one never sits on the composer (#5801).
        "sm:top-0 sm:bottom-[var(--overlay-bottom,0px)] sm:left-auto sm:right-0 sm:border-t-0 sm:border-l " +
        width
      }
      // The home indicator sits over the panel's last few points; pad the
      // content up off it so the composer / last row stays tappable.
      style={{ paddingBottom: "var(--inset-bottom)" }}
    >
      {children}
    </div>,
    document.body,
  );
}
