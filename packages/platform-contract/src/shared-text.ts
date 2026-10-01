// What a person shares or pastes from a shopping app: a product's title and
// its link, as one piece of text ("Samsung 990 EVO 2TB NVMe SSD
// https://a.co/d/xyz"), or as the share sheet's separate title, text and url.
//
// The ONE parse for every door that takes it: the share target (/scan/share),
// the scan box, and a paste anywhere on the inbox. The title is the person's
// own evidence of what the thing is, so it is kept as the item's name and the
// link as its source. A shop page that blocks automated reads (Amazon's often
// does) then loses nothing: the name was already in hand.

export interface SharedProduct {
  /** What the person's text called it, cleaned of the share sheet's own
   *  furniture ("Check out this product on Amazon"). Null when the text said
   *  nothing but the link. */
  title: string | null;
  url: string;
}

export interface SharedInput {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TITLE_MAX = 300;

/** A link as typed, without the punctuation a sentence leaves on its end. */
function trimUrl(u: string): string | null {
  const t = u.replace(/[),.;:!?\]}>'"]+$/, "");
  try {
    return new URL(t).hostname ? t : null;
  } catch {
    return null;
  }
}

// The share sheet's own words, never the product's: a lead-in ("Check out this
// product on Amazon:"), and a shop's name on the end of a page title ("... :
// Amazon.com: Electronics", "| eBay").
const LEAD_INS = [
  // Only a real lead-in, and only up to its colon or dash: "Found Objects" is
  // a book, so "found" alone never strips anything.
  /^(?:hey[,!]?\s+)?(?:check\s+(?:this|it)\s+out|(?:check\s+out|look\s+at|have\s+a\s+look\s+at|i\s+(?:found|saw|like)|found|see)\s+(?:this|these|that)(?:\s+(?:product|item|listing|deal|one))?)(?:\s+(?:on|at|from)\s+[^:\n]{2,30}?)?\s*[:,!\-–—]\s*/i,
  /^(?:shared|sent)\s+(?:from|via)\s+[^:\n]{2,30}?\s*[:\-–—]\s*/i,
]
const SHOP_TAILS = [
  /\s*[:|\-–—]\s*Amazon\.[a-z.]+(?:\s*[:|\-–—].*)?$/i,
  /\s+on\s+Amazon(?:\.[a-z.]+)?\s*$/i,
  /\s*[|\-–—]\s*(?:eBay|Etsy|Walmart\.com|Walmart|Target|Best Buy|AliExpress|Temu|Home Depot|Lowe's)\s*$/i,
];

/** The title a share carried, or null when it carried none worth keeping. */
export function cleanSharedTitle(raw: string | null | undefined): string | null {
  let t = (raw ?? "").replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  for (const re of LEAD_INS) t = t.replace(re, "");
  // A shop page's own title: "Amazon.com: <product> : <department>".
  const shopPage = /^Amazon\.[a-z.]+\s*[:|\-–—]\s*/i;
  if (shopPage.test(t)) t = t.replace(shopPage, "").replace(/\s+:\s+[^:]{2,40}$/, "");
  for (const re of SHOP_TAILS) t = t.replace(re, "");
  t = t.replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, "").replace(/[\s:,;\-–—|]+$/g, "").trim();
  if (t.length < 3 || !/\p{L}/u.test(t)) return null;
  return t.slice(0, TITLE_MAX);
}

/** Every product a share or a paste names, in order: each link with the words
 *  that came with it. A line holding a link takes the rest of that line as its
 *  title; a link alone on its line takes the words on the lines just above it
 *  ("Title\nhttps://..." is how a copied share often lands). One link per
 *  product; the same link twice is one product. */
export function parseSharedText(input: SharedInput | string): SharedProduct[] {
  const given: SharedInput = typeof input === "string" ? { text: input } : input;
  const text = given.text ?? "";
  const out: SharedProduct[] = [];
  const seen = new Set<string>();
  let pending: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const urls = (line.match(URL_RE) ?? []).map(trimUrl).filter((u): u is string => !!u);
    if (urls.length === 0) {
      if (line.trim()) pending.push(line.trim());
      continue;
    }
    const own = cleanSharedTitle(line);
    const title = own ?? cleanSharedTitle(pending.join(" "));
    pending = [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ title: urls.length === 1 ? title : null, url });
    }
  }
  // The share sheet's separate fields: the url given apart from the text
  // (Android sends a shop's link in `url` or inside `text`, depending on the
  // app), and its title, used when the text named nothing.
  const url = given.url ? trimUrl(given.url.trim()) : null;
  if (url && !seen.has(url)) {
    seen.add(url);
    out.push({ title: cleanSharedTitle(pending.join(" ")) ?? cleanSharedTitle(given.title), url });
  }
  if (out.length === 1 && !out[0]!.title) out[0]!.title = cleanSharedTitle(given.title);
  return out;
}

// Words a sentence ends on just before a link it is ASKING about ("is this in
// stock at https://..."), which a product title never does.
const DANGLING = new Set([
  "at", "on", "in", "from", "to", "via", "here", "this", "see", "for", "of", "with", "and", "or", "is", "the", "a", "an",
  "add", "added", "buy", "bought", "order", "ordered", "get", "got", "check", "find", "save", "saved",
]);
// How a question or a note to oneself opens ("did I already add <link>",
// "where is <link>"), which a product title never does.
const ASKING = new Set([
  "did", "do", "does", "is", "are", "was", "were", "can", "could", "should", "would", "will", "have", "has",
  "where", "what", "when", "why", "how", "which", "who", "i", "my", "we", "our", "remember", "todo", "note",
]);

/** Whether typed or pasted text is confidently a product shared with its
 *  link, rather than somebody searching their own notes. The scan box adds on
 *  this and SEARCHES otherwise, because filtering is harmless and a wrong add
 *  is not: one link, the link ending its line, at least two words of title
 *  before it, no question (by its mark or by how it opens), and no sentence
 *  left hanging on "at", "on" or "add". */
export function looksShared(text: string): boolean {
  const products = parseSharedText(text);
  if (products.length !== 1) return false;
  const p = products[0]!;
  if (!p.title || p.title.includes("?")) return false;
  const words = p.title.split(/\s+/);
  if (words.length < 2) return false;
  const word = (w: string) => w.toLowerCase().replace(/[^a-z]/g, "");
  if (DANGLING.has(word(words[words.length - 1]!)) || ASKING.has(word(words[0]!))) return false;
  // Nothing but punctuation after the link on its line: "... at <url> today"
  // is a sentence, not a share.
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(p.url);
    if (at >= 0) return /^[\s),.;:!\]}>'"]*$/.test(line.slice(at + p.url.length));
  }
  return false;
}
