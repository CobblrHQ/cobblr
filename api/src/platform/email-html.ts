// The house HTML email.
//
// Lifted out of super-admin.ts, where it was `feedbackEmailHtml` and only
// feedback replies could reach it. The invite emails were plaintext for no
// better reason than living in a different function, so the first thing a new
// person ever received from Cobblr was the plainest mail we send.
//
// Deliberately inline-styled and table-free: every mail client mangles
// something, and inline styles on simple blocks is the shape that survives.

import { escHtml } from "./esc-html.js";

export interface CobblrEmail {
  greeting: string;
  /** Optional quoted block above the body (a report, an ask). */
  quoteLabel?: string;
  quoteText?: string;
  bodyParas: string[];
  ctaUrl?: string;
  ctaLabel?: string;
  footerNote?: string;
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
  return `<!DOCTYPE html><html><body style="margin:0;background:#f3f4f6;padding:24px 12px;">
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;font-size:15px;line-height:1.5;max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 28px 24px;">
    <p style="margin:0 0 16px;">${escHtml(opts.greeting)}</p>
    ${quote}
    ${opts.bodyParas.map(para).join("")}
    ${cta}
    ${opts.footerNote ? `<p style="margin:14px 0 0;color:#9ca3af;font-size:12px;">${escHtml(opts.footerNote)}</p>` : ""}
    <p style="margin:18px 0 0;color:#9ca3af;font-size:12px;">The Cobblr team</p>
  </div></body></html>`;
}
