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
