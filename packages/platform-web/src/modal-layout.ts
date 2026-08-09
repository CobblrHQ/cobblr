// How a modal claims space. Pulled out of Modal.tsx as plain string logic so
// the two rules that keep colliding can be asserted (modal-layout.test.ts)
// rather than re-discovered on a phone:
//
//  1. On a phone a modal is the WHOLE SCREEN. A floating card with 1rem gutters
//     wastes the little room there is, and its action row ended up under the
//     floating pills (2026-08-01).
//  2. UNLESS something live is behind it. The scan result card sits over a
//     running viewfinder on purpose; full-bleed turned it into a blocking page
//     and hid the thing you were pointing at, which is the regression rule 1
//     caused (feedback: "that one actually needed to be the way that it was").
//
// dvh everywhere, never vh: on iOS 100vh is the LARGE viewport (measured as if
// the browser toolbars were retracted), so a vh-sized overlay is taller than
// the screen and its bottom row is unreachable. lint:no-vh-overlays enforces it.

/** The panel's own sizing classes. */
export function modalPanelLayout(overLive: boolean, fillHeight: boolean): string {
  if (overLive) {
    // A centred card at EVERY width, so the live surface stays visible around it.
    return (
      "my-8 rounded-xl max-h-[calc(100dvh-4rem)] " +
      (fillHeight ? "min-h-[calc(100dvh-4rem)] " : "")
    );
  }
  return (
    "my-0 rounded-none sm:my-8 sm:rounded-xl " +
    "max-h-[100dvh] sm:max-h-[calc(100dvh-4rem)] " +
    "min-h-[100dvh] sm:min-h-0 " +
    // The home indicator sits over the sheet's last few points, so pad the
    // footer up off it (0 in a browser / on desktop).
    "pb-[env(safe-area-inset-bottom)] sm:pb-0 " +
    (fillHeight ? "sm:min-h-[calc(100dvh-4rem)] " : "")
  );
}

/** The backdrop's gutters. Full-bleed needs none on a phone; a card always does. */
export function modalOverlayPadding(overLive: boolean): string {
  return overLive ? "p-4" : "p-0 sm:p-4";
}
