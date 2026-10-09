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
import { namedAddress } from "@cobblr/platform-contract/address-name";

/** Headers for an email of the receipts flow (#5462). It comes FROM the
 *  person's own receipts address, named "Cobblr Receipts" (or "Cobblr Receipts
 *  (<workspace>)"), so Gmail suggests that name when they next type "Cobblr"
 *  in a To field. It used to come from receipt-noreply@, which made the one
 *  name Gmail learned point at an address that files nothing. No Reply-To. A
 *  reply now reaches the receipts address, so isReplyToCobblr below keeps a
 *  "what is this?" from being filed as a junk inbox item, the 2026-07-24 bug
 *  the no-reply sender was there to stop. Threads under the original via
 *  In-Reply-To/References. */
export function receiptReplyHeaders(
  address: string | null | undefined,
  messageId: string | undefined,
  /** ownAddressNameFor(...): always the workspace's own name for it. */
  name: string,
): { from?: string; replyTo?: string; inReplyTo?: string; references?: string } {
  const out: { from?: string; replyTo?: string; inReplyTo?: string; references?: string } = {};
  if (address) out.from = namedAddress(name, address);
  const mid = (messageId || "").trim();
  if (mid) {
    out.inReplyTo = mid;
    out.references = mid;
  }
  return out;
}

const AUTO_REPLY = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|abwesenheitsnotiz|r[ée]ponse automatique|respuesta autom[áa]tica)\b/i;
/** A quoted header or attribution naming one of Cobblr's own senders. */
const OURS = /(cobblr receipts|cobblr orders|receipts\+[^@\s>]+@|orders\+[^@\s>]+@|receipt-noreply@)/i;

/** An email that is a person's reply to one of Cobblr's own emails, or an
 *  out-of-office answering one, rather than something forwarded to file. The
 *  quoted part names Cobblr's sender ("On Tue, Cobblr Receipts <receipts+…>
 *  wrote:"), and nothing above the quote was forwarded. Pure. */
export function isReplyToCobblr(email: { subject?: string | null; text?: string | null; attachments?: readonly unknown[] }): boolean {
  const subject = email.subject ?? "";
  if (AUTO_REPLY.test(subject)) return true;
  if (email.attachments && email.attachments.length > 0) return false;
  const text = email.text ?? "";
  if (/-{2,}\s*Forwarded message\s*-{2,}|^\s*Begin forwarded message:/im.test(text)) return false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*On .+wrote:\s*$/.test(line) && OURS.test(line)) return true;
    if (/^\s*>?\s*From:\s.+/.test(line) && OURS.test(line)) return true;
  }
  return false;
}
