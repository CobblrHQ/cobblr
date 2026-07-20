// The unguessable per-ticket hash behind a printer self-test link
// (debug.cobblr.xyz/<hash>). A STATELESS HMAC of the feedback id — no table —
// exactly like feedback-reply.ts, but domain-separated by a purpose tag so a
// diagnostic hash can NOT be used as an email reply token and vice versa.
//
// Shares the COBBLR_INBOUND_EMAIL_SECRET (the platform's inbound-link secret). The
// hash is the capability: whoever holds it may append a diagnostic to THAT ticket
// and nothing else, so it is safe to ship to the user's browser.

import crypto from "node:crypto";

const SECRET = process.env.COBBLR_INBOUND_EMAIL_SECRET || "";
const PURPOSE = "printer-diagnostic";

export function printerDiagnosticEnabled(): boolean {
  return Boolean(SECRET);
}

function mac(id32: string): string {
  return crypto.createHmac("sha256", SECRET).update(`${PURPOSE}:${id32}`).digest("base64url").slice(0, 16);
}

/** Mint the link hash for a feedback ticket: `<id32>.<mac>`, or null if disabled. */
export function printerDiagnosticToken(feedbackId: string): string | null {
  if (!SECRET) return null;
  const id32 = feedbackId.replace(/-/g, "");
  return `${id32}.${mac(id32)}`;
}

/** Verify the link hash → the feedback uuid, or null if the signature is bad. */
export function verifyPrinterDiagnosticToken(token: string): string | null {
  if (!SECRET) return null;
  const [id32, sig] = token.split(".");
  if (!id32 || !sig || !/^[0-9a-f]{32}$/i.test(id32)) return null;
  const expect = mac(id32);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`;
}
