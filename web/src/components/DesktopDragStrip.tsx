// Handles to move the Cobblr desktop app's window.
//
// The app runs its webview under the macOS title bar so Cobblr's own background
// reaches the top edge. The cost is that there is no title bar left to grab, and
// the window could not be moved at all.
//
// `data-tauri-drag-region` is Tauri's own mechanism: its injected script sees the
// attribute on mousedown and asks the native side to start a window drag, and a
// double-click toggles maximize the way a real title bar does. The app grants
// this page the two permissions that needs, scoped to its origin and to this one
// window (grant_instance_ipc in the desktop app).
//
// The route NOT taken, because it was tried and silently failed: fetching the
// app's local HTTP surface. That works in a browser and never in the app —
// WKWebView blocks an https page from reaching http://127.0.0.1 as mixed
// content, so no socket is ever opened and the failure looks exactly like the
// app not running. Verified by watching the port during a fresh launch: zero
// connections.

import { useEffect, useState } from "react";

/** The band the window controls sit in, matching the padding
 *  `html.desktop-app .desktop-titlebar-pad` adds to the sidebar head. */
const SIDEBAR_BAND_PX = 28;

/** The content column's own top padding (`py-6`). The band over the content may
 *  be no taller than this, because that is the only strip guaranteed to hold
 *  nothing. */
const CONTENT_BAND_PX = 24;

export function DesktopDragStrip({ pinned = false, topBar = false }: { pinned?: boolean; topBar?: boolean }) {
  // The class the shell sets pre-paint from the user agent. Read once, so an
  // ordinary browser renders nothing at all — these are INVISIBLE overlays, and
  // in a browser that corner holds the wordmark and the workspace switcher.
  const [inApp] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("desktop-app"),
  );
  const [atTop, setAtTop] = useState(true);

  // The band over the CONTENT column exists only while the page is unscrolled.
  //
  // The sidebar is sticky, so its top 28px is permanently padding and safe to
  // cover. The content column is not: it scrolls under anything fixed, so a
  // permanent band there would sit over whatever happened to be passing beneath
  // it and swallow clicks on real controls, invisibly. At scroll 0 that strip is
  // the column's own padding and holds nothing by construction.
  useEffect(() => {
    if (!inApp) return;
    const onScroll = () => setAtTop(window.scrollY <= 2);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [inApp]);

  if (!inApp) return null;

  return (
    <>
      {/* When the nav is a TOP BAR, that bar is fixed and its first 28px are the
          strip reserved for the window controls — empty at every scroll position,
          so the drag region can simply live there permanently. Nothing else is
          needed: the bar covers the full width. */}
      {topBar && (
        <div
          aria-hidden
          data-tauri-drag-region
          className="fixed top-0 inset-x-0 z-50"
          style={{ height: SIDEBAR_BAND_PX }}
        />
      )}
      {/* Over the sidebar head. Live even while scrolled, because a PINNED
          sidebar is sticky and never passes anything under this band. */}
      {!topBar && pinned && (
        <div
          aria-hidden
          data-tauri-drag-region
          className="hidden md:block fixed top-0 left-0 w-56 z-50"
          style={{ height: SIDEBAR_BAND_PX }}
        />
      )}
      {/* The rest of the top edge — chrome to look at, so expected to drag.
          Only while unscrolled. Without a pinned sidebar there is no safe strip
          at all once scrolled, so the whole band goes with it. */}
      {!topBar && atTop && (
        <div
          aria-hidden
          data-tauri-drag-region
          className={`hidden md:block fixed top-0 right-0 z-50 ${pinned ? "left-56" : "left-0"}`}
          style={{ height: CONTENT_BAND_PX }}
        />
      )}
    </>
  );
}
