// Client state for an active operator-impersonation ("View as") session. Stored
// in sessionStorage so it's PER-TAB and dies when the tab closes (never
// localStorage). The token rides every API request as `X-Impersonation`
// (api.ts); the banner + border read this; ActiveOrgContext treats the
// impersonated workspace as active even though the operator isn't a member.
// See docs/modules/operator-impersonation.md.

import { useSyncExternalStore } from "react";

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

export function getImpersonation(): ImpersonationSession | null {
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

export function clearImpersonation(): void {
  sessionStorage.removeItem(KEY);
  emit();
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
