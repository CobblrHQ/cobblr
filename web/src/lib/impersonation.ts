// Client state for an active operator-impersonation ("View as") session. Stored
// in sessionStorage so it's PER-TAB and dies when the tab closes (never
// localStorage). The token rides every API request as `X-Impersonation`
// (api.ts); the banner + border read this; ActiveOrgContext treats the
// impersonated workspace as active even though the operator isn't a member.
// See docs/modules/operator-impersonation.md.

import { useSyncExternalStore } from "react";
import { markPageLeaving } from "./page-leaving";

const KEY = "cobblr.impersonation";
const EVENT = "cobblr-impersonation-change";

export interface ImpersonationSession {
  session_id: string;
  token: string;
  expires_at: string; // ISO
  mode: "read" | "write";
  target: { id: string; name: string; role: string };
  workspace: { id: string; slug: string; name: string };
}

/** The session this page is leaving: its own last requests still carry it
 *  while the next page loads, which reads none. */
let leavingWith: ImpersonationSession | null = null;

const ENDING_KEY = "cobblr.impersonation.ending";

/** Exit: stop new requests and go to `to`, leaving the session to be ended
 *  by the page that opens there (finishEndingImpersonation). Ended from this
 *  page, a poll already in flight was answered after the end, as a refusal. */
export function endAndLeaveImpersonation(to: string, go?: (url: string) => void): void {
  const s = getImpersonation();
  if (s) sessionStorage.setItem(ENDING_KEY, JSON.stringify({ session_id: s.session_id }));
  leaveImpersonation(to, go);
}

/** On the console: end the session the last page left, once. */
export async function finishEndingImpersonation(end: (s: { session_id: string }) => Promise<unknown>): Promise<void> {
  const raw = sessionStorage.getItem(ENDING_KEY);
  if (!raw) return;
  sessionStorage.removeItem(ENDING_KEY);
  try {
    await end(JSON.parse(raw) as { session_id: string });
  } catch {
    /* best-effort: the grant expires regardless */
  }
}

export function getImpersonation(): ImpersonationSession | null {
  if (leavingWith) return leavingWith;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as ImpersonationSession;
    if (new Date(s.expires_at).getTime() <= Date.now()) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** Just the token, for the api client (kept import-light so api.ts ⇏ React). */
export function getImpersonationToken(): string | null {
  return getImpersonation()?.token ?? null;
}

function emit(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function setImpersonation(s: ImpersonationSession): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
  emit();
}

export function setImpersonationMode(mode: "read" | "write"): void {
  const s = getImpersonation();
  if (!s) return;
  sessionStorage.setItem(KEY, JSON.stringify({ ...s, mode }));
  emit();
}

/** End the session in this tab and go to `to` (the console). The page is told
 *  nothing first: told, the workspace it was viewing re-renders as one the
 *  operator is not a member of and sends them to their own workspace, and that
 *  later navigation won over this one, so Exit landed on the operator's own
 *  dashboard instead of the console. The next page reads no session; this
 *  one keeps it until it unloads, so a poll in flight is not refused. */
export function leaveImpersonation(to: string, go: (url: string) => void = (url) => window.location.assign(url)): void {
  markPageLeaving();
  leavingWith = getImpersonation();
  sessionStorage.removeItem(KEY);
  go(to);
}

// Reactive read: re-renders on any set/clear/mode-change (this tab) — and on the
// native `storage` event, though that only fires cross-tab and sessionStorage is
// per-tab, so it's just belt-and-suspenders.
function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
let cached: { raw: string | null; value: ImpersonationSession | null } = { raw: null, value: null };
function snapshot(): ImpersonationSession | null {
  // Stable reference between changes so useSyncExternalStore doesn't loop.
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cached.raw) cached = { raw, value: getImpersonation() };
  return cached.value;
}

export function useImpersonation(): ImpersonationSession | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
