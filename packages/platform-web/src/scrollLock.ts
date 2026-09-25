// Holding the page still under an overlay: ONE way, so opening a menu can
// never move the page.
//
// `html, body, #root` are full height (web/src/index.css). Locking overflow on
// BOTH <html> and <body> makes <body> its own clipping box one screen tall, so
// the document is suddenly one screen long and the scroll position clamps to
// the top. The session header's menu did exactly that: a tap on a session far
// down the Scan page threw the page to the top and drew the menu offscreen
// (#3718). Locking <body> alone stops the page scrolling and keeps where it
// is, which is what the four other overlays already did, each by hand.
//
// Counted, because overlays nest (a modal opened from a menu): each one
// restoring "the value it saw" put the page back to locked, or unlocked,
// depending on which closed first.
import { useEffect } from "react";

let holders = 0;
let saved = "";

/** Stop the page scrolling behind an overlay; returns the release. Safe to
 *  call more than once: the page unlocks when the last holder lets go. */
export function lockPageScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (holders === 0) {
    saved = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) document.body.style.overflow = saved;
  };
}

/** lockPageScroll for as long as `active` holds. */
export function useLockPageScroll(active = true): void {
  useEffect(() => (active ? lockPageScroll() : undefined), [active]);
}
