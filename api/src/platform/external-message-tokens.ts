// The reply link's token (#6070, slice 3b): one message, one workspace, a
// date it stops working. Apart from external-messages.ts, with the secret
// handed in, so a test can make one and read it after its date.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface ReplyClaim { o: string; l: string; e: number }

function signReply(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`external-reply:${payload}`).digest("base64url");
}

export function replyToken(c: ReplyClaim, secret: string): string {
  const payload = Buffer.from(JSON.stringify(c)).toString("base64url");
  return `${payload}.${signReply(payload, secret)}`;
}

/** The claim, or why there is none: a link that is not one Cobblr made, or
 *  one that is past its date. */
export function readReplyToken(token: string, secret: string, now = Date.now()): ReplyClaim | "bad" | "expired" {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return "bad";
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(signReply(payload, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "bad";
  try {
    // b64-lenient-ok: the signature was checked over the payload string as given, so only its one spelling reaches here.
    const c = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<ReplyClaim>;
    if (typeof c.o !== "string" || typeof c.l !== "string" || typeof c.e !== "number") return "bad";
    return now > c.e ? "expired" : { o: c.o, l: c.l, e: c.e };
  } catch {
    return "bad";
  }
}
