// Title + author -> ISBN via Open Library. The REVERSE of resolveIsbn (which
// goes ISBN->book for a scanned barcode): a PHOTOGRAPHED book has no scannable
// ISBN — vision only reads the cover — so we look it up from what vision read.
// Prefers the EDITION whose publisher matches the item's brand (the Scholastic
// paperback the user actually has, not a random hardcover). Keyless public API;
// best-effort; in-process cached so a shelf of one series hits it once per title.

import { userAgent } from "@cobblr/platform-contract/outbound-identity";

interface OlSearchDoc {
  key?: string;
  isbn?: string[];
}
interface OlEdition {
  publishers?: string[];
  isbn_13?: string[];
  isbn_10?: string[];
  publish_date?: string;
}

const cache = new Map<string, { isbn: string | null; at: number }>();
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

/** Best-effort ISBN-13 for a book identified only by title (+ author, +
 *  publisher). Returns null when nothing usable is found — the caller leaves the
 *  ISBN blank rather than inventing one. Never throws. */
export async function lookupBookIsbn(
  title: string,
  author?: string | null,
  publisher?: string | null,
): Promise<string | null> {
  const t = (title ?? "").trim();
  if (t.length < 3) return null;
  const key = `${norm(t)}|${norm(author ?? "")}|${norm(publisher ?? "")}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.isbn;
  let isbn: string | null = null;
  try {
    isbn = await resolve(t, author, publisher);
  } catch {
    isbn = null;
  }
  cache.set(key, { isbn, at: Date.now() });
  return isbn;
}

async function resolve(title: string, author?: string | null, publisher?: string | null): Promise<string | null> {
  const p = new URLSearchParams({ title, limit: "1", fields: "key,isbn" });
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
          if (m) return m;
        }
        const any = eds.map((e) => pickIsbn13(e.isbn_13)).find(Boolean) ?? null;
        if (any) return any;
      }
    } catch {
      /* fall through to the work-level isbn below */
    }
  }
  return pickIsbn13(doc.isbn);
}
