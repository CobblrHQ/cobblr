// Public-signup feature flag. Lives in its own module so unit tests
// can import it without dragging in the full route + DB graph
// (which calls process.exit on missing env at import time).
//
// Precedence:
//   1. Explicit PUBLIC_SIGNUP_ENABLED true/1/yes → open.
//   2. Explicit false/0/no → closed.
//   3. Unset → open in dev/test, CLOSED in production (failure-safe).

export function publicSignupEnabled(): boolean {
  const raw = process.env.PUBLIC_SIGNUP_ENABLED?.toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

// Managed-app signup: whether a `/start/:app` consumer signup ("Cobblr for Yarn")
// is allowed when generic public signup is closed. This is the **funnel lever** —
// it opens ONLY managed-app signups (which land in a locked single-app workspace),
// never generic platform signup, so the consumer product can launch without
// opening the whole platform. Default CLOSED in prod (opening it is an
// outward-facing go-live decision: cost / abuse / support) — set
// COBBLR_MANAGED_APP_SIGNUP_ENABLED=true on a deployment to open the funnel there
// (e.g. staging, to test the flow). Same precedence as public signup; unset = open
// in dev/test, closed in prod. (When publicSignupEnabled() is already true this is
// moot — generic signup, managed-app included, is open.)
export function managedAppSignupEnabled(): boolean {
  const raw = process.env.COBBLR_MANAGED_APP_SIGNUP_ENABLED?.toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

// Self-serve invites: whether a regular workspace OWNER can mint a "start your
// own Cobblr" link (a new person → their OWN fresh workspace). This is the
// uncontrolled-growth lever — each invitee becomes an owner who can invite
// more — so it defaults CLOSED in production (alpha-safe). Flip
// COBBLR_SELF_SERVE_INVITES=true when ready to open the floodgates. Same
// precedence as public signup; unset = open in dev/test, closed in prod.
export function selfServeInvitesEnabled(): boolean {
  const raw = process.env.COBBLR_SELF_SERVE_INVITES?.toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return process.env.NODE_ENV !== "production";
}

// Signup-invite expiry (audit L-INVITE). An invite link is a credential;
// "no expiry given" used to mean "live forever", which left years-old links
// redeemable. Every mint site (super-admin, waitlist approve, self-serve)
// computes its expiry HERE so none of them can regress to never-expiring:
// an explicit expires_in_days is honoured, an omitted one gets the default.
export const DEFAULT_INVITE_EXPIRY_DAYS = 14;

export function inviteExpiresAt(expiresInDays: number | undefined, now: number = Date.now()): Date {
  return new Date(now + (expiresInDays ?? DEFAULT_INVITE_EXPIRY_DAYS) * 86_400_000);
}
