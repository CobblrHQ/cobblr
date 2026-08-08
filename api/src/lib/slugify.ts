// The one implementation of "human name → URL-safe slug".
//
// It lives here, alone and dependency-free, because it had TWO implementations:
// the real one in routes/auth.ts and a hand-copied one in
// api/tests/org-slug-generation.test.ts. The copy drifted the moment the real
// one learned to fold accents, so the test would have gone on asserting the old
// broken behaviour while calling itself coverage. One export, imported by both.

/** Letters that carry no combining mark, so NFD leaves them intact and the
 *  ASCII filter below would otherwise eat them. Latin-1/Nordic/Central-European
 *  coverage, which is who actually signs up with a non-ASCII workspace name. */
const LETTER_FOLDS: Array<[RegExp, string]> = [
  [/[øö]/g, "o"],
  [/[æ]/g, "ae"],
  [/[œ]/g, "oe"],
  [/[ß]/g, "ss"],
  [/[đð]/g, "d"],
  [/[þ]/g, "th"],
  [/[ł]/g, "l"],
  [/[ı]/g, "i"],
];

/** URL-safe slug from a human name.
 *
 *  Accented and non-ASCII letters are FOLDED to their ASCII base rather than
 *  dropped. They used to hit `[^a-z0-9]` and become hyphens, which mangled every
 *  non-English name: "Müllers Werkstatt" gave `m-llers-werkstatt`, and worse, a
 *  leading letter vanished outright, so "Åsas Verkstad" gave `sas-verkstad` and
 *  Åsa lost the first letter of her own name at signup. NFD splits a letter from
 *  its combining mark so the mark alone is stripped (å, ü, é, ñ, ç); the folds
 *  above cover the letters NFD cannot decompose (ø, æ, ß, ł).
 *
 *  Anything still non-ASCII after folding (Greek, Cyrillic, CJK) collapses to a
 *  hyphen as before, and a name that folds to nothing at all still yields "org",
 *  so a slug is always well-formed. */
export function slugifyBase(name: string): string {
  let s = name.toLowerCase();
  for (const [re, to] of LETTER_FOLDS) s = s.replace(re, to);
  return (
    s
      // Separate combining marks, then drop them: "å" → "a", "ü" → "u".
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Strip a possessive "'s" entirely (not just the apostrophe), so
      // "Alex's Workspace" → "alex-workspace". A trailing word boundary
      // means only the possessive goes — "Tools Workshop" keeps its s.
      .replace(/['’]s\b/g, "")
      // …then drop any remaining apostrophes ("O'Brien" → "obrien").
      .replace(/['’`]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      // A slice can land on a hyphen ("...-"), which is not a slug we want.
      .replace(/-+$/g, "") || "org"
  );
}
