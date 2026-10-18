// Title + author -> ISBN via Open Library. The REVERSE of resolveIsbn (which
// goes ISBN->book for a scanned barcode): a PHOTOGRAPHED book has no scannable
// ISBN — vision only reads the cover — so we look it up from what vision read.
// Prefers the EDITION whose publisher matches the item's brand (the Scholastic
// paperback the user actually has, not a random hardcover). Keyless public API;
// best-effort; in-process cached so a shelf of one series hits it once per title.

// EGRESS-FILE: vendor-fixed - the book catalogue's host, written in the code
import { userAgent } from "@cobblr/platform-contract/outbound-identity";

interface OlSearchDoc {
  key?: string;
  isbn?: string[];
  title?: string;
}
interface OlEdition {
  publishers?: string[];
  isbn_13?: string[];
  isbn_10?: string[];
  publish_date?: string;
}

const cache = new Map<string, { isbn: string | null; title?: string | null; at: number }>();
const TTL_MS = 24 * 60 * 60 * 1000;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const digits = (s: string) => s.replace(/[^0-9Xx]/g, "");
const yearOf = (d?: string) => {
  const m = (d ?? "").match(/\d{4}/);
  return m ? Number(m[0]) : 0;
};
function reqInit(): RequestInit {
  return {
    signal: AbortSignal.timeout(6000),
    headers: { "User-Agent": userAgent("openlibrary lookup"), Accept: "application/json" },
  };
}
function pickIsbn13(list?: string[]): string | null {
  const xs = (list ?? []).map(digits);
  return xs.find((s) => s.length === 13 && /^(978|979)/.test(s)) ?? xs.find((s) => s.length === 13) ?? null;
}

/** The ISBN a row already knows from its own decode (the code scanned was an
 *  ISBN, and the book catalog's bag carries it), or null for a row that has
 *  none: a photographed cover, a product. The one case where a title lookup
 *  must not be asked, because it answers with an edition, not this one. */
export function decodedIsbnOf(suggestedMetadata: unknown): string | null {
  const fields = (suggestedMetadata as { decoded?: { fields?: Record<string, unknown> } } | null)?.decoded?.fields;
  const raw = fields?.isbn;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const isbn = digits(String(raw)).toUpperCase();
  return isbn.length === 10 || isbn.length === 13 ? isbn : null;
}

/** The catalog's own title for the work a title search found, with its
 *  ISBN, so a caller can check the match against what the item says before
 *  it believes the number (#3613). Null when nothing usable was found. */
export async function lookupBookByTitle(
  title: string,
  author?: string | null,
  publisher?: string | null,
): Promise<{ isbn: string; title: string } | null> {
  const t = (title ?? "").trim();
  if (t.length < 3) return null;
  const key = `${norm(t)}|${norm(author ?? "")}|${norm(publisher ?? "")}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.isbn ? { isbn: cached.isbn, title: cached.title ?? "" } : null;
  let found: { isbn: string; title: string } | null = null;
  try {
    const r = await resolveWithTitle(t, author, publisher);
    found = r.isbn ? { isbn: r.isbn, title: r.title } : null;
  } catch {
    found = null;
  }
  cache.set(key, { isbn: found?.isbn ?? null, title: found?.title ?? null, at: Date.now() });
  return found;
}

async function resolveWithTitle(title: string, author?: string | null, publisher?: string | null): Promise<{ isbn: string | null; title: string }> {
  const found = await resolveDoc(title, author, publisher);
  return found ?? { isbn: null, title: "" };
}

async function resolveDoc(title: string, author?: string | null, publisher?: string | null): Promise<{ isbn: string | null; title: string } | null> {
  const p = new URLSearchParams({ title, limit: "1", fields: "key,isbn,title" });
  if (author?.trim()) p.set("author", author.trim());
  const sr = await fetch(`https://openlibrary.org/search.json?${p.toString()}`, reqInit());
  if (!sr.ok) return null;
  const doc = ((await sr.json()) as { docs?: OlSearchDoc[] }).docs?.[0];
  if (!doc) return null;

  // Edition-match by publisher when we can — the exact printing the user has.
  if (doc.key) {
    try {
      const er = await fetch(`https://openlibrary.org${doc.key}/editions.json?limit=200`, reqInit());
      if (er.ok) {
        const eds = ((await er.json()) as { entries?: OlEdition[] }).entries ?? [];
        const pub = norm(publisher ?? "");
        if (pub) {
          const matched = eds
            .filter(
              (e) =>
                pickIsbn13(e.isbn_13) &&
                (e.publishers ?? []).some((x) => {
                  const n = norm(x);
                  return !!n && (n.includes(pub) || pub.includes(n));
                }),
            )
            .sort((a, b) => yearOf(b.publish_date) - yearOf(a.publish_date)); // newest printing first
          const m = matched[0] ? pickIsbn13(matched[0].isbn_13) : null;
          if (m) return { isbn: m, title: doc.title ?? "" };
        }
        const any = eds.map((e) => pickIsbn13(e.isbn_13)).find(Boolean) ?? null;
        if (any) return { isbn: any, title: doc.title ?? "" };
      }
    } catch {
      /* fall through to the work-level isbn below */
    }
  }
  return { isbn: pickIsbn13(doc.isbn), title: doc.title ?? "" };
}

const titleWords = (s: string): string[] =>
  s
    .toLowerCase()
    .split(":")[0]!
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an"].includes(w));

/** Does a catalog's title name the book whose title was READ off the item?
 *  The same words in the same order, subtitle aside. A description of the
 *  thing ("Blank softcover book") is no title at all, so a search on it can
 *  never corroborate the ISBN it returns (#3613). */
export function catalogTitleCorroborated(readTitle: string | null | undefined, catalogTitle: string | null | undefined): boolean {
  const a = titleWords(readTitle ?? "");
  const b = titleWords(catalogTitle ?? "");
  return a.length > 0 && a.join(" ") === b.join(" ");
}
