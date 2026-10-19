// The house HTML email.
//
// Lifted out of super-admin.ts, where it was `feedbackEmailHtml` and only
// feedback replies could reach it. The invite emails were plaintext for no
// better reason than living in a different function, so the first thing a new
// person ever received from Cobblr was the plainest mail we send.
//
// Deliberately inline-styled and table-free: every mail client mangles
// something, and inline styles on simple blocks is the shape that survives.

import { productName } from "./product-name.js";
import { escHtml } from "./esc-html.js";

/** One line of an aside: plain text, a link, or a bold phrase, in order. */
export type EmailLine = Array<string | { text: string; href: string } | { strong: string }>;

export interface CobblrEmail {
  greeting: string;
  /** Optional quoted block above the body (a report, an ask). */
  quoteLabel?: string;
  quoteText?: string;
  bodyParas: string[];
  ctaUrl?: string;
  ctaLabel?: string;
  footerNote?: string;
  /** A short headed list after the body, before the button (the feedback
   *  emails' Discord invitation). Omitted, or with no lines, it is absent. */
  aside?: { heading: string; lines: EmailLine[] };
}

const lineHtml = (line: EmailLine): string =>
  line
    .map((seg) =>
      typeof seg === "string"
        ? escHtml(seg)
        : "href" in seg
          ? `<a href="${escHtml(seg.href)}" style="color:#8a6f47;">${escHtml(seg.text)}</a>`
          : `<strong>${escHtml(seg.strong)}</strong>`,
    )
    .join("");

/** The same lines for the plain-text part, each URL written out. A link whose
 *  text is its own address is written once. */
export function emailLinesText(lines: EmailLine[]): string {
  return lines
    .map(
      (line) =>
        "• " +
        line
          .map((seg) =>
            typeof seg === "string" ? seg : "href" in seg ? (seg.href.endsWith(seg.text) ? seg.href : `${seg.text} (${seg.href})`) : seg.strong,
          )
          .join(""),
    )
    .join("\n");
}

export function cobblrEmailHtml(opts: CobblrEmail): string {
  const para = (t: string) => `<p style="margin:0 0 14px;">${escHtml(t).replace(/\n/g, "<br>")}</p>`;
  const quote = opts.quoteText
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:13px;">${escHtml(opts.quoteLabel || "You reported:")}</p>
       <blockquote style="margin:0 0 18px;padding:10px 16px;border-left:3px solid #c7b8a6;background:#f6f3ee;color:#374151;border-radius:0 6px 6px 0;white-space:pre-wrap;">${escHtml(opts.quoteText)}</blockquote>`
    : "";
  // A CTA is optional: "you're on the list" has nothing to click, and a button
  // that goes nowhere is worse than no button.
  const cta = opts.ctaUrl && opts.ctaLabel
    ? `<p style="margin:22px 0 8px;"><a href="${escHtml(opts.ctaUrl)}" style="display:inline-block;background:#8a6f47;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px;">${escHtml(opts.ctaLabel)}</a></p>`
    : "";
  const asideLines = opts.aside?.lines ?? [];
  const aside = asideLines.length
    ? `<p style="margin:18px 0 10px;font-weight:600;">${escHtml(opts.aside!.heading)}</p>` +
      asideLines.map((l, i) => `<p style="margin:0 0 ${i === asideLines.length - 1 ? 14 : 10}px;">&bull; ${lineHtml(l)}</p>`).join("")
    : "";
  return `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f6;padding:24px 12px;">
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.5;max-width:560px;margin:0 auto;overflow-wrap:anywhere;word-break:break-word;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 28px 24px;">
    <p style="margin:0 0 16px;">${escHtml(opts.greeting)}</p>
    ${quote}
    ${opts.bodyParas.map(para).join("")}
    ${aside}
    ${cta}
    ${opts.footerNote ? `<p style="margin:14px 0 0;color:#6b7280;font-size:12px;">${escHtml(opts.footerNote)}</p>` : ""}
    <p style="margin:18px 0 0;color:#6b7280;font-size:12px;">The ${escHtml(productName())} team</p>
  </div></body></html>`;
}
