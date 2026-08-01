// Drives the guided tour: auto-opens ONCE per user, and only on a workspace
// that is still empty (the first-run hero state) - an established workspace
// never spontaneously starts coaching. Replayable any time via startTour()
// (the account-menu "Take the tour").
//
// Seen-state is keyed BY USER, not by device alone: the old global key meant a
// user's second workspace on the same browser never toured, while the same
// user on a new device toured again over a full workspace (new-user-flow.md
// F4). The legacy global key is still honored as "seen" so nobody who already
// took the tour gets it replayed.

import { useEffect, useState } from "react";

const LEGACY_SEEN_KEY = "cobblr.tour.dashboard.v1";
const seenKey = (userId: string | null) => `cobblr.tour.dashboard.v1:${userId ?? "anon"}`;
export const START_TOUR_EVENT = "cobblr:start-tour";

/** Replay the tour from anywhere (e.g. the account menu). */
export function startTour(): void {
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

export function useTour(enabled: boolean, userId: string | null): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false);

  // First qualifying visit: auto-open once, after the dashboard has painted.
  useEffect(() => {
    if (!enabled) return;
    try {
      if (localStorage.getItem(seenKey(userId)) || localStorage.getItem(LEGACY_SEEN_KEY)) return;
    } catch {
      return;
    }
    const id = window.setTimeout(() => setOpen(true), 600);
    return () => window.clearTimeout(id);
  }, [enabled, userId]);

  // On-demand replay.
  useEffect(() => {
    const onStart = () => setOpen(true);
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  const close = () => {
    try {
      localStorage.setItem(seenKey(userId), "1");
    } catch {
      /* private mode - the tour will re-offer next session, which is fine */
    }
    setOpen(false);
  };
  return { open, close };
}
