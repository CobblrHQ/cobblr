// Vehicle paint-code resolution, Tiers 0 + 1 (heuristic-first, zero tokens).
// See docs/design-decisions/vehicle-color-resolution.md.
//
//   Tier 0 — extractPaintCode(): pull the code the label read ALREADY captured
//            out of the item's existing text (a matchmaker/vision note like
//            "door jamb label shows color code NH830M"). Deterministic regex;
//            NO new AI/vision call.
//   Tier 1 — lookupPaintCode() (paint-code-table.ts): the curated table.
//
// resolvePaintColorFromText() composes them: text → code → name. It stays PURE
// (no I/O) so it's fully unit-tested and can run anywhere; the caller decides
// where the code/name land and whether to try a later (web-search / AI) tier
// when the table misses.

import { lookupPaintCode, normalizePaintCode } from "./paint-code-table.js";

// The label prefix ("color code" / "colour code" / "paint code"), then we scan a
// short window after it for the first CODE-SHAPED token. Requiring the word
// "code" keeps this precise — it won't fire on "color: red" prose.
const LABEL_RE = /\b(?:colou?r|paint)\s*code\b[\s:#=]*/i;

/**
 * Tier 0: extract a paint code the vision/matchmaker pass already read, from any
 * text on the item (notes, photo observations). Returns the normalized code
 * (uppercase, no spaces/hyphens) or null.
 *
 * Precision over recall: we require the literal "…code" label AND a token that
 * carries a DIGIT (essentially all real paint codes do — NH830M, 040, 1F7, KH3).
 * That rejects filler words that follow the label ("color code was not legible"
 * → the only all-letter tokens are skipped). A rare all-letter code (Nissan QAB)
 * is intentionally NOT matched here — better a miss (later tier) than to also
 * swallow words like "was"/"the". A mis-grabbed non-code (e.g. a year) simply
 * misses the table and leaves the field blank — safe.
 */
export function extractPaintCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = LABEL_RE.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const window = text.slice(start, start + 24);
  const tokens = window.match(/[A-Za-z0-9]{2,8}/g) ?? [];
  for (const t of tokens) {
    if (/\d/.test(t)) return normalizePaintCode(t);
  }
  return null;
}

export interface PaintColorResolution {
  /** The extracted, normalized paint code. */
  code: string;
  /** The resolved marketing name, or null when the code isn't in the Tier-1
   *  table yet (the caller may try a later tier with `code`). */
  name: string | null;
  /** Where `name` came from — null when unresolved (code found, table miss). */
  source: "paint-code-table" | null;
}

/** Every plausible paint-code token in a blob of text: alnum runs of 2–7 chars
 *  that carry a digit (real paint codes do — NH830M, 040, K1X, 46V), normalized,
 *  in order, de-duped. Used to table-match without needing a "color code" label. */
function codeTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z0-9]{2,7}/g) ?? []) {
    if (!/\d/.test(raw)) continue; // paint codes carry a digit
    const n = normalizePaintCode(raw);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Tiers 0+1 composed. Two ways to find the code in `text`, table-first:
 *
 *  1. **Table-match any code-shaped token.** The vision usually just LISTS the
 *     label's codes ("Additional codes visible are TGG K LJ5 NH830M") with no
 *     "color code" label — so we try every digit-bearing token against the
 *     make's table; the one that RESOLVES *is* the paint code (a factory/interior
 *     code like TGG/LJ5 is in no table, so it self-disambiguates).
 *  2. **Labelled fallback.** If nothing table-matches, an explicit "colo(u)r/
 *     paint code XXX" gives a specific token for a later (web-search) tier to
 *     resolve — returned as `{ code, name: null }`.
 *
 * Returns null when no code is found at all. Pure.
 */
export function resolvePaintColorFromText(
  make: string,
  text: string | null | undefined,
): PaintColorResolution | null {
  if (!text) return null;
  // 1. Table-match: the resolving token is the paint code.
  for (const tok of codeTokens(text)) {
    const name = lookupPaintCode(make, tok);
    if (name) return { code: tok, name, source: "paint-code-table" };
  }
  // 2. Labelled fallback for a code not in the table (→ web-search tier).
  const code = extractPaintCode(text);
  if (code) return { code, name: null, source: null };
  return null;
}
