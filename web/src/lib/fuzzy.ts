// Typo-tolerant text matching for the onboarding / tracker search, so "pprint"
// still finds "Printers" and "machne" finds "Machines". Dependency-free:
// substring first (exact wins + cheap), else Sørensen–Dice similarity over
// character bigrams per token — robust to typos, no edit-distance DP.

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. "pprint" vs
 *  "printers" ≈ 0.67; unrelated words ≈ 0. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  const counts = new Map<string, number>();
  for (const g of B) counts.set(g, (counts.get(g) ?? 0) + 1);
  let inter = 0;
  for (const g of A) {
    const c = counts.get(g);
    if (c) {
      inter++;
      counts.set(g, c - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

const SPLIT = /[^a-z0-9]+/;
const THRESHOLD = 0.5;

/** Typo-tolerant "does `haystack` match `query`?". Exact substring wins; else
 *  EVERY query token must fuzzy-match some haystack token (a substring, or Dice
 *  ≥ 0.5). Tokens shorter than 3 chars require an exact substring (a 2-char typo
 *  match is noise). Case-insensitive. */
export function fuzzyMatch(haystack: string, query: string): boolean {
  const h = haystack.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return true;
  if (h.includes(q)) return true;
  const hTokens = h.split(SPLIT).filter(Boolean);
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((qt) =>
      qt.length < 3
        ? hTokens.some((ht) => ht.includes(qt))
        : hTokens.some((ht) => ht.includes(qt) || diceSimilarity(qt, ht) >= THRESHOLD),
    );
}
