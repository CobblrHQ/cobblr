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
