// Where a NEW person lands when they redeem an invite.
//
// The invite link used to be built from the admin console's own host, which is
// whichever instance an operator happens to be signed into. An operator can run
// more than one: a private instance for people they know personally, and a
// public one anybody may be sent to. Building the link from the console meant a
// waitlist approval could mail a stranger a link into the private one.
//
//   COBBLR_SIGNUP_SURFACE_URL=https://app.cobblr.example.com
//
// Unset, it falls back to the request's own host, which is right for every
// self-hoster: their admin console and their app are the same origin, and this
// has to keep behaving exactly as it did for them.

/** The origin new signups should be sent to, or "" to use the request's host. */
export function signupSurfaceUrl(): string {
  return (process.env.COBBLR_SIGNUP_SURFACE_URL || "").trim().replace(/\/+$/, "");
}

/**
 * Absolute URL for a path on the surface a new person should land on.
 *
 * `requestOrigin` is the caller's own origin, used only when no surface is
 * configured. Passing it in (rather than reading a global) keeps this pure and
 * lets a test prove the fallback without a live request.
 */
export function signupSurfaceLink(path: string, requestOrigin: string): string {
  const base = signupSurfaceUrl() || (requestOrigin || "").replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}
