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

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#160": " ",
};

/** Good-enough HTML → text for an emailed receipt whose only content is html.
 *  Strips scripts/styles, turns block boundaries into newlines, drops tags, and
 *  decodes the common entities. Not a full renderer — just enough to hand a
 *  receipt's text to the parser / capture. */
export function htmlToText(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(p|div|tr|table|li|h[1-6]|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\/?td\b[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (/^#\d+$/.test(e) ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** The best plain-text body for a RECEIPT: the plain part if it carries real
 *  content, else the html rendered to text (many store receipts are html-only).
 *  Picks whichever yields more text — a forwarded email often has a sparse plain
 *  part and the real receipt in html. */
export function bestReceiptBody(text: string | undefined, html: string | undefined): string {
  const plain = (text || "").trim();
  const fromHtml = htmlToText(html);
  return fromHtml.length > plain.length ? fromHtml : plain;
}

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
