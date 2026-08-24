// Drives the guided tour: auto-opens ONCE PER PERSON, and only on a workspace
// that is still empty (the first-run hero state) - an established workspace
// never spontaneously starts coaching. Replayable any time via startTour()
// (the account-menu "Take the tour").
//
// SEEN-STATE LIVES ON THE ACCOUNT. localStorage is a cache for the first paint,
// not the record - the same split nav-mode.ts settled for the same reason.
//
// It used to be localStorage alone, keyed by user id. That is per BROWSER and
// per ORIGIN, which is three ways to forget something a person already sat
// through: a second device, the main host vs a preview host, and clearing
// site data. The report was "entering a new workspace shows me the tour again",
// and a new workspace is exactly where a forgotten flag becomes visible -
// because a forgotten flag can only open the tour where the tour is offered at
// all, which is on an EMPTY workspace.
//
// So `users.tour_seen_at` is the truth and crosses all three. The local key is
// still honoured on the way in (nobody mid-load gets it replayed) and is
// BACKFILLED up to the account on first sight, so existing users are carried
// over without being shown anything.

import { useEffect, useRef, useState } from "react";

const LEGACY_SEEN_KEY = "cobblr.tour.dashboard.v1";
const seenKey = (userId: string | null) => `cobblr.tour.dashboard.v1:${userId ?? "anon"}`;
export const START_TOUR_EVENT = "cobblr:start-tour";

/** Replay the tour from anywhere (e.g. the account menu). */
export function startTour(): void {
  window.dispatchEvent(new Event(START_TOUR_EVENT));
}

function localSeen(userId: string | null): boolean {
  try {
    return Boolean(localStorage.getItem(seenKey(userId)) || localStorage.getItem(LEGACY_SEEN_KEY));
  } catch {
    // Private mode. Treat as seen rather than as never: re-offering a tour on
    // every single visit is worse than not offering it to somebody who has
    // blocked storage.
    return true;
  }
}

export interface TourAccountState {
  /** users.tour_seen_at from /me. `undefined` = the account has not loaded yet,
   *  which is NOT the same as never and must not open anything. */
  seenAt?: string | null;
  /** Persist "seen" to the account. */
  markSeen?: () => void;
}

export function useTour(
  enabled: boolean,
  userId: string | null,
  account: TourAccountState = {},
): { open: boolean; close: () => void } {
  const [open, setOpen] = useState(false);
  const backfilled = useRef(false);
  const { seenAt, markSeen } = account;

  // Carry an existing local flag up to the account, once. Without this every
  // user who already toured would be shown it one more time on their next empty
  // workspace - the exact complaint, re-introduced by the fix for it.
  useEffect(() => {
    if (backfilled.current || !userId || seenAt === undefined) return;
    if (seenAt === null && localSeen(userId)) {
      backfilled.current = true;
      markSeen?.();
    }
  }, [userId, seenAt, markSeen]);

  // First qualifying visit: auto-open once, after the dashboard has painted.
  useEffect(() => {
    if (!enabled) return;
    // Account still loading. Opening now would show the tour to somebody who
    // has already taken it, on the screen where that is most irritating.
    if (seenAt === undefined || seenAt !== null) return;
    if (localSeen(userId)) return;
    const id = window.setTimeout(() => setOpen(true), 600);
    return () => window.clearTimeout(id);
  }, [enabled, userId, seenAt]);

  // On-demand replay.
  useEffect(() => {
    const onStart = () => setOpen(true);
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, []);

  const close = () => {
    // Both: the local key so this tab stops offering it instantly, the account
    // so every other device, origin and workspace agrees.
    try {
      localStorage.setItem(seenKey(userId), "1");
    } catch {
      /* private mode - localSeen() already treats that as seen */
    }
    markSeen?.();
    setOpen(false);
  };
  return { open, close };
}
