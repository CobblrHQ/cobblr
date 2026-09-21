// Is the window at the desktop breakpoint (Tailwind's md, 768px), read live?
//
// A half-width window is a resize, not a device (unlike useIsTouch, which is
// sampled once), so this re-reads as the window changes. It owns the md
// query for JS: a CSS `md:` class answers the same question for markup, and a
// JS gate that needs the answer takes it from here rather than growing its
// own matchMedia (scripts/capabilities.ts holds it to that).
import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 768px)";

function media(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && window.matchMedia ? window.matchMedia(QUERY) : null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  const m = media();
  if (!m) return () => undefined;
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}

/** Without a matchMedia (a test, a server) the answer is the desktop one. */
function read(): boolean {
  return media()?.matches ?? true;
}

export function useIsDesktopWidth(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
