const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#160": " ",
};

/** A store's logo, as the words it stands for: the shop's name, on its own
 *  line where a printed receipt puts it. Any other picture says nothing. */
function logoText(img: string): string {
  if (!/\b(?:src|class)\s*=\s*["'][^"']*logo/i.test(img)) return "";
  const alt = img.match(/\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i);
  const name = (alt?.[1] ?? alt?.[2] ?? "").trim();
  return name ? `\n${name}\n` : "";
}

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
    .replace(/<img\b[^>]*>/gi, logoText)
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
