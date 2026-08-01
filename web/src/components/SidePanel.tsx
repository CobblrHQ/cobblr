// The one right-side overlay panel (Ask Cobb, Notifications). It exists to hold
// two rules in ONE place, both learned from the mobile bug where Ask Cobb sat
// shifted down with its composer below the fold (the author, 2026-08-01):
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
import type { ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { HIDE_WHEN_OVERLAY_OPEN, useOverlayOpenFlag } from "@cobblr/platform-web";

/** Re-exported for the floating chrome that already imports it from here.
 *  The flag itself lives in platform-web now, because MODALS set it too. */
export const HIDE_WHEN_SIDE_PANEL_OPEN = HIDE_WHEN_OVERLAY_OPEN;


export function SidePanel({
  width,
  panelRef,
  escapeExempt = false,
  children,
}: {
  /** Desktop width. Mobile is always full-bleed. */
  width: string;
  panelRef?: Ref<HTMLDivElement>;
  escapeExempt?: boolean;
  children: ReactNode;
}) {
  useOverlayOpenFlag();
  return createPortal(
    <div
      ref={panelRef}
      {...(escapeExempt ? { "data-modal-escape-exempt": true } : {})}
      className={
        "fixed inset-x-0 bottom-0 top-[var(--app-header-bottom,3.5rem)] z-[60] flex flex-col " +
        "border-t border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl " +
        // Desktop: back to the familiar full-height drawer on the right edge.
        // top/bottom are overridden by NAME (not sm:inset-y-0) so the win over
        // top-[var(…)] doesn't depend on how Tailwind orders inset-* vs top-*.
        "sm:top-0 sm:bottom-0 sm:left-auto sm:right-0 sm:border-t-0 sm:border-l " +
        width
      }
      // The home indicator sits over the panel's last few points; pad the
      // content up off it so the composer / last row stays tappable.
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {children}
    </div>,
    document.body,
  );
}
