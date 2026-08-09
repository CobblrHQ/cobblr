// Reply-by-email plumbing: a tokenized Reply-To so a recipient's reply to a
// feedback email is routed back inbound and appended to the right item, instead
// of vanishing into the sender's mailbox. The token is a STATELESS HMAC of the
// feedback id (no table). The whole feature is OFF unless BOTH env are set:
//
//   COBBLR_FEEDBACK_REPLY_DOMAIN  e.g. "cobblr.example.com" — where Cloudflare Email
//                                 Routing catches reply+*@<domain> and hands it
//                                 to the Email Worker.
//   COBBLR_INBOUND_EMAIL_SECRET   HMAC secret. The SAME value must be set on the
//                                 Worker so it can authenticate to append-email.
//
// Until both are set, feedbackReplyAddress() returns null (no Reply-To) and the
// emails keep the "replies aren't monitored — reply in-app" wording.

import crypto from "node:crypto";

const DOMAIN = (process.env.COBBLR_FEEDBACK_REPLY_DOMAIN || "").trim();
const SECRET = process.env.COBBLR_INBOUND_EMAIL_SECRET || "";

export function feedbackReplyEnabled(): boolean {
  return Boolean(DOMAIN && SECRET);
}

function mac(id32: string): string {
  return crypto.createHmac("sha256", SECRET).update(id32).digest("base64url").slice(0, 16);
}

/** Tokenized Reply-To for a feedback item, or null when reply-by-email is off. */
export function feedbackReplyAddress(feedbackId: string): string | null {
  if (!feedbackReplyEnabled()) return null;
  const id32 = feedbackId.replace(/-/g, "");
  return `reply+${id32}.${mac(id32)}@${DOMAIN}`;
}

/** Verify a reply token (the local-part after "reply+") → the feedback uuid, or
 *  null if the signature doesn't check out. */
export function verifyReplyToken(token: string): string | null {
  if (!SECRET) return null;
  const [id32, sig] = token.split(".");
  if (!id32 || !sig || !/^[0-9a-f]{32}$/i.test(id32)) return null;
  const expect = mac(id32);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`;
}
