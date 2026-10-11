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
export function emailLineImages(
  html: string | null | undefined,
  /** The email's own image parts by Content-ID ("cid:…" in the html), each
   *  already stored and referenced as `file:<id>` (#5719). A forward from a
   *  phone or a mail app carries the store's pictures this way, not as links. */
  inline: Readonly<Record<string, string>> = {},
): EmailLineImage[] {
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
    const src = attr(imgs[0]!, "src");
    const cid = src?.match(/^cid:(.+)$/i)?.[1];
    const url = cid ? (inline[cid.replace(/^<|>$/g, "")] ?? null) : src;
    if (!url || !isLineImageRef(url) || seen.has(url)) continue;
    const text = textOf(block);
    if (!/[a-z]{3}/i.test(text) || !LINE_WORDS.test(text)) continue;
    seen.add(url);
    out.push({ text: text.slice(0, 500), url });
    if (out.length >= MAX_LINE_IMAGES) break;
  }
  return out;
}

/** A line picture's reference: a link the email printed, or one of the
 *  email's own image parts, stored (`file:<uuid>`). */
export function isLineImageRef(url: string): boolean {
  return /^https?:\/\//i.test(url) || storedLineImageId(url) !== null;
}

/** The stored file a `file:<uuid>` reference names, else null. */
export function storedLineImageId(url: string | null | undefined): string | null {
  return url?.match(/^file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] ?? null;
}

/** The html's "cid:" images, in the order it first names them. */
export function emailImageCids(html: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (html ?? "").matchAll(/<img\b[^>]*\bsrc\s*=\s*["']?cid:([^"'\s>]+)/gi)) {
    const id = m[1]!.replace(/^<|>$/g, "");
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** A plain-text forward's pictures (#5719): a mail app writes each inline
 *  image into the text part as "[image: <its alt text>]" where it stood, and
 *  sends the image itself as a part, in the same order. Each placeholder
 *  takes the next stored part, and its words are the placeholder's and the
 *  lines after it, up to the next one, so lineImagesFor pairs it with the
 *  line it printed beside. */
export function textLineImages(text: string | null | undefined, parts: readonly string[]): EmailLineImage[] {
  if (!text || parts.length === 0) return [];
  const marks = [...text.matchAll(/\[image:\s*([^\]]*)\]/gi)];
  const out: EmailLineImage[] = [];
  marks.forEach((m, i) => {
    const url = parts[i];
    if (!url || !isLineImageRef(url)) return;
    const end = marks[i + 1]?.index ?? text.length;
    // The placeholder's own row: the next few lines, and only one price. A
    // logo's placeholder above the whole order holds every line's price,
    // and is no line's picture.
    const after = text.slice((m.index ?? 0) + m[0].length, end).split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" ");
    if ((after.match(/[$£€¥]\s?\d/g) ?? []).length > 1) return;
    const words = `${m[1] ?? ""} ${after}`.replace(/\s+/g, " ").trim();
    if (!/[a-z]{3}/i.test(words) || !LINE_WORDS.test(words)) return;
    out.push({ text: words.slice(0, 500), url });
  });
  return out.slice(0, MAX_LINE_IMAGES);
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

/** One part of an inbound email, as the mail worker sends it. */
export interface EmailPart {
  content_type?: string;
  filename?: string;
  /** The part's Content-ID, without its angle brackets. */
  content_id?: string;
  /** "inline" for a picture the message shows in its body. */
  disposition?: string;
}

/** Which of an email's parts are pictures it SHOWS (the store's product
 *  photos, a logo), and the "cid:" each answers, in part order (#5719).
 *  Such a part is never a receipt to read: sent to the receipt reader, a
 *  forwarded order's four product photos were four failed reads and no
 *  line got its picture. A part with no Content-ID (an older forwarder)
 *  answers the html's next unanswered cid in order. An image the body never
 *  shows, or one sent as an attachment (a photographed receipt), stays a
 *  document. */
export function emailPictureParts(parts: readonly EmailPart[], body: { html?: string | null; text?: string | null }): Array<{ index: number; cid: string | null }> {
  const cids = emailImageCids(body.html);
  const placeholders = /\[image:/i.test(body.text ?? "");
  const shows = (p: EmailPart) => /^image\//i.test(p.content_type ?? "") || /\.(png|jpe?g|gif|webp)$/i.test(p.filename ?? "");
  const out: Array<{ index: number; cid: string | null }> = [];
  const answered = new Set<string>();
  parts.forEach((p, index) => {
    if (!shows(p)) return;
    const own = p.content_id?.replace(/^<|>$/g, "") || null;
    if (own && cids.includes(own)) {
      answered.add(own);
      out.push({ index, cid: own });
    } else if (p.disposition?.toLowerCase() === "inline" || (!own && !p.disposition && (cids.length > 0 || placeholders))) {
      out.push({ index, cid: own });
    }
  });
  const open = cids.filter((c) => !answered.has(c));
  for (const o of out) if (!o.cid || !cids.includes(o.cid)) o.cid = open.shift() ?? o.cid;
  return out;
}
