// Pure body helpers for the inbound-email seam — no DB/network, so they're
// unit-testable in isolation.
//
// The Cloudflare Worker now sends the FULL body (it used to strip quoted text,
// which destroyed FORWARDED receipts — the receipt lives in the quoted block).
// Quoting is trimmed HERE instead, and only on the feedback-reply path: a receipt
// wants the whole forwarded message.

/** Keep only the reply the person actually typed — cut at the first quoted block /
 *  "On … wrote:" attribution / original-message divider / forwarded header. Used
 *  ONLY for feedback replies (a receipt keeps its quoted/forwarded content). */
export function stripQuoted(body: string | undefined): string {
  const out: string[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    if (/^>/.test(line)) break;
    if (/^\s*On .+ wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^-{2,}\s*Forwarded message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}\s*$/.test(line)) break;
    if (/^From:\s.+@/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export { htmlToText, bestReceiptBody } from "@cobblr/platform-contract/email-body";

/** Headers for the receipt CONFIRMATION email. It is a ONE-WAY notification:
 *  From `receipt-noreply@<domain>` and NO Reply-To — an earlier version set
 *  Reply-To to the workspace's `receipts+<token>@` address, which meant a user who
 *  replied to ask a question ("what is this?") had their reply INGESTED as a junk
 *  inbox item (reported 2026-07-24). Ingest happens by FORWARDING a receipt to the
 *  address on the Scan page, never by replying here (and the dispatcher ignores
 *  mail to no-reply addresses). Still threads under the original via In-Reply-To/
 *  References so the confirmation lands in the same conversation. `address` is any
 *  workspace receipts address — used only to derive the sending domain. */
export function receiptReplyHeaders(
  address: string | null | undefined,
  messageId: string | undefined,
): { from?: string; replyTo?: string; inReplyTo?: string; references?: string } {
  const out: { from?: string; replyTo?: string; inReplyTo?: string; references?: string } = {};
  const domain = address ? (address.split("@")[1] ?? "") : "";
  if (domain) out.from = `Cobblr Receipts <receipt-noreply@${domain}>`;
  const mid = (messageId || "").trim();
  if (mid) {
    out.inReplyTo = mid;
    out.references = mid;
  }
  return out;
}
