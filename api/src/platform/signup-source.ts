// Where a new account came from: the link or QR that sent the person to sign up
// (`?source=3dp2026` on the booth's card), recorded on the account's first
// workspace as a `signed_up` product event, so the funnel can read a show's
// sign-ups beside its sandboxes (`sandbox_started`, `sandbox_carried_in`).
//
// A source is a label from a URL, so it is cleaned rather than trusted: the
// same shape the sandbox door accepts, lower-cased, anything else dropped. A
// bad one never refuses a sign-up; the account is made and the source is null.
import { trackProductEvent } from "./product-events.js";

/** The source as recorded, or null when there is none or it is not a label. */
export function cleanSignupSource(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(s) ? s : null;
}

/** Record a new account's arrival, with the source it came by. Best-effort. */
export function recordSignup(e: { orgId: string; userId: string; via: "form" | "identity"; source: unknown }): void {
  trackProductEvent({ orgId: e.orgId, userId: e.userId, event: "signed_up", detail: { via: e.via, source: cleanSignupSource(e.source) } });
}
