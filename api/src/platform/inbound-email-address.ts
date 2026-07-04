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
