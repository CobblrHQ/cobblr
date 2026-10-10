// An order email's own picture for each line (#5350). The owner, reviewing a
// Kingroon order: "the image to use/match is literally in the email." The
// email prints each product's photo in the same row as its title and variant,
// and the inbound path stripped every <img> before anything read the message,
// so each line's picture came from a web search instead: the same generic
// banner for two different multicolour packs.
//
// Pure, so the email path and a test read an email the same way. Two steps:
// emailLineImages pairs each image with the words of its row, and
// lineImagesFor gives each receipt line the one image whose words say it.

/** A line's picture as the email printed it, with the words beside it. */
export interface EmailLineImage {
  text: string;
  url: string;
}

const MAX_LINE_IMAGES = 30;

function textOf(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&times;/g, "×")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

/** A tracking pixel or a spacer: drawn at a pixel or two, never a product. */
function tiny(tag: string): boolean {
  const w = Number(attr(tag, "width"));
  const h = Number(attr(tag, "height"));
  return (Number.isFinite(w) && w > 0 && w <= 2) || (Number.isFinite(h) && h > 0 && h <= 2);
}

/** Words that read like an order line: a price or a quantity. A store's logo
 *  row and a marketing banner have neither, so their pictures are never a
 *  line's. */
const LINE_WORDS = /(?:[$£€¥]\s?\d|\d[.,]\d{2}\b|(?:^|[^a-z])[×x]\s?\d+\b|\bqty\b|\bquantity\b)/i;

/** Each table row (or, with no table, each block) that prints exactly one
 *  picture beside the words of an order line: the picture and those words. */
export function emailLineImages(html: string | null | undefined): EmailLineImage[] {
  if (!html) return [];
  const clean = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  // The innermost rows: a row holding a table of rows is not a line itself.
  const rows = [...clean.matchAll(/<tr\b[^>]*>((?:(?!<tr\b)[\s\S])*?)<\/tr>/gi)].map((m) => m[1] ?? "");
  const blocks = rows.length ? rows : clean.split(/<\/(?:p|div|li)>/i);
  const out: EmailLineImage[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const imgs = [...block.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]).filter((t) => !tiny(t));
    if (imgs.length !== 1) continue;
    const url = attr(imgs[0]!, "src");
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const text = textOf(block);
    if (!/[a-z]{3}/i.test(text) || !LINE_WORDS.test(text)) continue;
    seen.add(url);
    out.push({ text: text.slice(0, 500), url });
    if (out.length >= MAX_LINE_IMAGES) break;
  }
  return out;
}

/** The words of a line, without what every row of an order says beside them
 *  (a price, a quantity mark), so "Multicolor" and "Multicolor-1" stay apart. */
function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[$£€¥]\s?\d[\d.,]*/g, " ")
    .replace(/(^|[^a-z])[×x]\s?\d+\b/g, "$1 ")
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length >= 1);
}

function similarity(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  const either = A.size + B.size - both;
  return either ? both / either : 0;
}

/** The image each line gets, in line order, or null where none says it: each
 *  image goes to at most one line, the closest pair first, and a pair that
 *  shares too little is no pair. Two lines that differ only by a variant word
 *  ("Multicolor", "Multicolor-1") each find their own row. */
export function lineImagesFor(lines: readonly string[], images: readonly EmailLineImage[]): Array<string | null> {
  const out: Array<string | null> = lines.map(() => null);
  if (!images.length) return out;
  const lineWords = lines.map(wordsOf);
  const imageWords = images.map((i) => wordsOf(i.text));
  const pairs: Array<{ line: number; image: number; score: number }> = [];
  lineWords.forEach((lw, line) => imageWords.forEach((iw, image) => pairs.push({ line, image, score: similarity(lw, iw) })));
  pairs.sort((a, b) => b.score - a.score || a.line - b.line || a.image - b.image);
  const taken = new Set<number>();
  for (const p of pairs) {
    if (p.score < 0.6) break;
    if (out[p.line] !== null || taken.has(p.image)) continue;
    out[p.line] = images[p.image]!.url;
    taken.add(p.image);
  }
  return out;
}
