// Shared auth for every UNAUTHENTICATED inbound-email route. The Cloudflare
// Email Worker (the only legitimate caller) authenticates with one shared
// secret, COBBLR_INBOUND_EMAIL_SECRET, sent as the x-inbound-secret header. The
// receipt route, the feedback-reply route, AND the /inbound-email dispatcher all
// gate on this one check — keep it in one place so the constant-time comparison
// and the "unset secret ⇒ closed" invariant can't drift between them.

import crypto from "node:crypto";

/** Constant-time check of the shared inbound-email secret header. Returns false
 *  when the secret is unset (feature dormant) or the header doesn't match. */
export function inboundSecretOk(provided: unknown): boolean {
  const secret = process.env.COBBLR_INBOUND_EMAIL_SECRET || "";
  const got = String(provided ?? "");
  if (!secret || got.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}
