// Per-(user, workspace) receipt forwarding address — STATELESS + signed.
//
// A user gets a personal address PER workspace, e.g.
//   receipts+<token>@cobblr.me
// where <token> = base64url(userId16 ++ orgId16) + "." + base64url(hmac6). The
// token both NAMES the target (which user, which workspace — solving the
// multi-workspace ambiguity Ramp sidesteps by being one-org-per-user) and PROVES
// it (the HMAC, keyed on COBBLR_INBOUND_EMAIL_SECRET, can't be forged or typo'd
// into another workspace). It's stateless — nothing stored, derived on demand —
// and every address lands in ONE inbox: Cloudflare Email Routing catches
// receipts+*@<domain> into a single Email Worker.
//
// 32 payload bytes → 43 base64url chars; + "." + 8-char MAC = 52; + "receipts+"
// = 61, under the 64-char local-part limit. Mirrors the feedback reply-token
// (feedback-reply.ts); shares the same inbound secret + mail domain.
//
//   COBBLR_RECEIPT_EMAIL_DOMAIN   where Cloudflare catches receipts+*@<domain>
//                                 (falls back to COBBLR_FEEDBACK_REPLY_DOMAIN).
//   COBBLR_INBOUND_EMAIL_SECRET   HMAC key; SAME value set on the Email Worker.

import crypto from "node:crypto";

const SECRET = process.env.COBBLR_INBOUND_EMAIL_SECRET || "";
function domain(): string {
  return (process.env.COBBLR_RECEIPT_EMAIL_DOMAIN || process.env.COBBLR_FEEDBACK_REPLY_DOMAIN || "").trim();
}

/** Receipt-by-email is available only when both the mail domain + secret are
 *  set (i.e. the operator wired up Cloudflare Email Routing + the Worker). */
export function receiptEmailConfigured(): boolean {
  return Boolean(domain() && SECRET);
}

function uuidToBytes(u: string): Buffer {
  return Buffer.from(u.replace(/-/g, ""), "hex");
}
function bytesToUuid(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
function mac(payload: Buffer): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest().subarray(0, 6).toString("base64url");
}

/** The forwarding address for one (user, workspace), or null if unconfigured. */
export function mintReceiptAddress(userId: string, orgId: string): string | null {
  if (!receiptEmailConfigured()) return null;
  const payload = Buffer.concat([uuidToBytes(userId), uuidToBytes(orgId)]);
  return `receipts+${payload.toString("base64url")}.${mac(payload)}@${domain()}`;
}

/** Verify + decode a token (the part between "receipts+" and "@") → its
 *  (userId, orgId), or null if the MAC fails / it's malformed. */
export function verifyReceiptToken(token: string): { userId: string; orgId: string } | null {
  if (!SECRET) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  let payload: Buffer;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url");
  } catch {
    return null;
  }
  if (payload.length !== 32) return null;
  const got = token.slice(dot + 1);
  const want = mac(payload);
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  return { userId: bytesToUuid(payload.subarray(0, 16)), orgId: bytesToUuid(payload.subarray(16, 32)) };
}

/** Pull the receipts+<token> local-part out of a To header (string or list).
 *  Tolerates display-name forms like "Name <receipts+tok@d>". */
export function extractReceiptToken(to: string | string[] | undefined): string | null {
  const arr = Array.isArray(to) ? to : to ? [to] : [];
  for (const addr of arr) {
    const m = addr.match(/receipts\+([^@>\s]+)@/i);
    if (m) return m[1] ?? null;
  }
  return null;
}
