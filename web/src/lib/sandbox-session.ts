// Is this browser holding a no-account sandbox?
//
// Two very different components need the answer - the countdown bar, which only
// exists for a sandbox, and the new-version nudge, which must not - so the
// question is asked in one place. Two copies of a localStorage key is exactly
// the kind of thing that drifts silently: rename it once and one of the two
// quietly stops working, with nothing to show for it.
//
// The expiry is written by the landing page when the link is redeemed. It is
// per-browser and disposable, like the sandbox.
import { useEffect, useSyncExternalStore } from "react";

export const SANDBOX_EXPIRY_KEY = "cobblr.sandboxExpiresAt";

/** Millisecond timestamp the sandbox ends, or null when this is not one.
 *  Never throws: private mode and blocked site data both read as "not one". */
export function sandboxExpiry(): number | null {
  try {
    const raw = localStorage.getItem(SANDBOX_EXPIRY_KEY);
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function isSandboxSession(): boolean {
  return sandboxExpiry() !== null;
}

export function clearSandboxExpiry(): void {
  try {
    localStorage.removeItem(SANDBOX_EXPIRY_KEY);
  } catch {
    /* nothing to clean up */
  }
}

// ── the end ────────────────────────────────────────────────────────────────
//
// A sandbox's end is a TERMINAL state, not a strip under a live dashboard.
// The first ending was a bar saying "your hour is up, this sandbox was
// deleted" while the page kept painting its query cache, the api kept
// answering until the reaper swept, and the dashboard's content probe read
// the eventual failures as "empty" and opened the first-run tour on top
// (2026-09-14). Three things can say it is over, and they converge here:
//   the hint    the expiry the landing page wrote is in the past (a tab
//               reopened later; checked by useSandboxEnded on its own clock)
//   the server  410 sandbox_expired, from the tenant middleware on every
//               route (api.ts marks it; the browser's clock may be behind)
//   the strip   its countdown reached zero with the server's own expiry
// Once set, the workspace shell is replaced by the ending, whole.
const ENDED_EVT = "cobblr:sandbox-ended";
let ended = false;
// A keep or a take in flight. While one is, the end is noted, not acted on:
// the answer to "keep this workspace", tapped with two seconds left, must
// never be the ending page. The server has always let that keep land (the
// keep and take routes are not workspace routes, and the reaper's sweep is
// minutes behind the hour), so the only thing that could lose it was this
// page ending itself first.
let holds = 0;
let noted = false;

/** Over already? Reads the hint's clock too, so the very first render of a
 *  tab reopened after the hour is the ending, and the shell it would have
 *  drawn (and the workspace reads it would have fired) never happen. A latch:
 *  once true, true. */
export function sandboxEnded(): boolean {
  if (!ended && holds === 0) {
    const e = sandboxExpiry();
    if (e != null && e <= Date.now()) ended = true;
  }
  return ended;
}

/** Mark the sandbox over. Idempotent; the first call announces it. Held
 *  back while a keep or a take is in flight, and applied when it settles. */
export function markSandboxEnded(): void {
  if (holds > 0) {
    noted = true;
    return;
  }
  ended = true;
  try {
    window.dispatchEvent(new Event(ENDED_EVT));
  } catch {
    /* no window (tests) */
  }
}

/** Run a keep or a take with the end held back. `keeps` says the work, if
 *  it succeeds, makes the workspace not a sandbox any more: a noted end is
 *  then dropped (a kept workspace is never over) and the hint goes with it.
 *  A take, or a failed keep, releases the hold and the noted end applies. */
export async function holdSandboxEnd<T>(work: Promise<T>, opts: { keeps?: boolean } = {}): Promise<T> {
  holds += 1;
  try {
    const result = await work;
    if (opts.keeps) {
      noted = false;
      clearSandboxExpiry();
    }
    return result;
  } finally {
    holds -= 1;
    if (holds === 0 && noted) {
      noted = false;
      markSandboxEnded();
    }
  }
}

export function onSandboxEnded(fn: () => void): () => void {
  window.addEventListener(ENDED_EVT, fn);
  return () => window.removeEventListener(ENDED_EVT, fn);
}

/** True once the sandbox is over, by any of the three tellers. Watches the
 *  hint's clock itself, so a shell that never mounted the strip (a workspace
 *  the reaper already removed answers 404 to everything) still ends. */
export function useSandboxEnded(): boolean {
  const over = useSyncExternalStore(onSandboxEnded, sandboxEnded, sandboxEnded);
  useEffect(() => {
    if (over) return;
    const t = setInterval(() => {
      if (sandboxEnded()) markSandboxEnded();
    }, 15_000);
    return () => clearInterval(t);
  }, [over]);
  return over;
}

/** Tests only. */
export function resetSandboxEnded(): void {
  ended = false;
  holds = 0;
  noted = false;
}
