// The inbound-email dispatch decision, kept PURE (no DB / env / handler imports)
// so it's unit-testable on its own. The dispatcher (routes/inbound-email.ts)
// routes by the To local-part: reply+<token> → feedback, everything else →
// receipt ingest. Getting this wrong parses a feedback reply as a receipt (or
// vice-versa), so it earns a dedicated test.

/** First reply+<token> found across the To address(es), or null. */
export function replyTokenFrom(to: string | string[] | undefined): string | null {
  const arr = Array.isArray(to) ? to : to ? [to] : [];
  for (const a of arr) {
    const m = a.match(/reply\+([^@]+)@/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** True when the mail was sent TO one of OUR no-reply addresses — i.e. it's a
 *  reply to a one-way notification we sent (receipt-noreply@ / noreply@ /
 *  no-reply@). Such mail must be DROPPED, never ingested: a user replying to a
 *  receipt confirmation ("what is this?") used to land as a junk inbox item. */
export function isNoReplyAddress(to: string | string[] | undefined): boolean {
  const arr = Array.isArray(to) ? to : to ? [to] : [];
  return arr.some((a) => /(^|[<\s,])(receipt-noreply|no-?reply)@/i.test(a));
}
