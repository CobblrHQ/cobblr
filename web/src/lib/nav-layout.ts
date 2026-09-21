// Which shell a window gets. The "full sidebar" layout (nav in the sidebar,
// no top bar; Notion/Linear) is a DESKTOP layout: below the md breakpoint the
// sidebar is hidden and the phone shell takes over, so everything the full
// sidebar carries in its foot (the verify-email card, Feedback and the live
// box, the toast stack's home over the rail) needs its ordinary mount again.
// The layout choice alone used to decide this, and a half-width window, or a
// phone that had synced a desktop's preference, lost all three (#3326).
export function isFullSidebar(input: { navMode: "top" | "side"; navTopBar: boolean; appMode: boolean; desktopWidth: boolean }): boolean {
  return input.navMode === "side" && !input.navTopBar && !input.appMode && input.desktopWidth;
}
