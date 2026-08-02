// ONE category for a scan session.
//
// Every item is identified INDEPENDENTLY, so each invents its own free-text
// category with nothing anchoring it to its siblings. Three Under Armour
// t-shirts scanned together came back "apparel", "apparel" and "clothing", shown
// as "Clothing" and "clothing" - three items, three labels, when the user wanted
// one section holding all three (the author, 2026-07-30).
//
// Reconciliation is inherently CROSS-ITEM, so it cannot live in the per-item
// identify: it belongs after, over the session. This is the free heuristic floor
// - case, punctuation, plurals and a small synonym vocabulary for the generic
// clusters. Only a session the heuristic genuinely cannot settle is worth asking
// a model about.
//
// The rule when labels differ is BROADEST THAT FITS (the author's call): three t-shirts
// become "Clothing", not "T-Shirts". Fewer, bigger sections, and the category
// field's own hint already says a category that outgrows its table can be
// promoted into one of its own later - so broad now is not a trap.

/** Canonical label for a family of near-synonyms, and the words that map to it.
 *  Deliberately GENERIC vocabulary (the kind of word an identify reaches for),
 *  never a per-bundle or per-workspace list. */
const SYNONYMS: Array<{ canonical: string; words: string[] }> = [
  { canonical: "clothing", words: ["clothing", "clothes", "apparel", "garment", "wearable", "wear"] },
  { canonical: "footwear", words: ["footwear", "shoe", "sneaker", "boot"] },
  { canonical: "tool", words: ["tool", "hand tool", "power tool", "toolage"] },
  { canonical: "electronics", words: ["electronic", "electronics", "device", "gadget"] },
  { canonical: "food", words: ["food", "grocery", "groceries", "foodstuff", "edible"] },
  { canonical: "book", words: ["book", "books", "media", "publication"] },
  { canonical: "fastener", words: ["fastener", "fasteners", "hardware"] },
  { canonical: "part", words: ["part", "parts", "component", "components", "spare"] },
];

/** Strip a trailing plural. Regular plurals only - deliberately not a stemmer:
 *  over-stemming invents words, and a wrong canonical is worse than two labels. */
function singular(w: string): string {
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + "y";
  if (/(ches|shes|xes|zes|ses)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** The canonical label when `raw` belongs to a known synonym family, else null.
 *  Separate from `normaliseCategory` because callers need to know whether a
 *  value EARNED a rewrite: "apparel" did, "PLA" did not, and only the first may
 *  have its casing replaced on screen. */
export function canonicalSynonym(raw: string | null | undefined): string | null {
  const s = comparable(raw);
  if (!s) return null;
  for (const { canonical, words } of SYNONYMS) {
    if (words.some((w) => w === s || s === singular(w))) return canonical;
  }
  return null;
}

/** Lowercase, unpunctuated, singular - the form two labels are compared in.
 *
 *  The hyphen used to survive, which quietly defeated the synonym table:
 *  "Power Tool" reduced to "tool" while "power-tool" stayed "power-tool", so two
 *  spellings of one category compared as different. Folding it to a space makes
 *  this strictly stronger than the ad-hoc `[^a-z0-9]` normalizers it replaces,
 *  which is what let all of them adopt it without trading one gap for another. */
function comparable(raw: string | null | undefined): string | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.split(" ").map(singular).join(" ");
}

/** A category string reduced to its comparable form: lowercase, unpunctuated,
 *  singular, and mapped onto a canonical synonym when it belongs to one.
 *  "Apparel" / "clothes" / "Clothing " all become "clothing". */
export function normaliseCategory(raw: string | null | undefined): string | null {
  return canonicalSynonym(raw) ?? comparable(raw);
}

/** Title Case for display: "clothing" -> "Clothing", "hand tool" -> "Hand Tool". */
export function displayCategory(canonical: string): string {
  return canonical.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * How a category VALUE is shown, ANYWHERE it is shown - chip, session header,
 * routing note.
 *
 * The same category reached the screen three ways in one session: "Clothing" on
 * one card, "clothing" on the next, and “apparel” in the note under both (the author,
 * 2026-07-30: "your cases are not matching up suggesting a larger issue"). One
 * fact rendered by three call sites is the drift; one function is the fix.
 *
 * Only a SYNONYM match earns a rewrite. A label the vocabulary does not know
 * keeps whatever casing its author gave it, so an acronym or a brandish word
 * ("PLA", "PPE") is not quietly retitled to "Pla" - a lowercase-only label is
 * still title-cased, since that casing carries no intent.
 */
export function categoryDisplay(value: string): string {
  const synonym = canonicalSynonym(value);
  if (synonym) return displayCategory(synonym);
  return /[A-Z]/.test(value) ? value : displayCategory(value);
}

export interface CategoryConsensus {
  /** The single category to offer, display-cased. Null when nothing had one. */
  suggestion: string | null;
  /** True when every item already meant the same thing (only case/plural/synonym
   *  differed) - so the offer is a tidy-up, not a decision to be second-guessed. */
  unanimous: boolean;
  /** The distinct raw labels seen, for showing what is being reconciled. */
  seen: string[];
}

/**
 * The one category to file a whole scan session under.
 *
 * Unanimous after normalising -> that label. Otherwise the most common; ties go
 * to the label that appeared FIRST, which is stable rather than arbitrary. An
 * item with no category at all does not vote (a blank is not an opinion) but is
 * still covered by the result, which is the point: the user gets one section.
 */
/**
 * The label to SHOW for a winning canonical key.
 *
 * Canonicalisation exists so "Book" and "Books" can AGREE with each other. It is
 * a matching device, and it used to leak into naming: a workspace whose category
 * is "Books" was shown "Book", a word that appears nowhere in their data
 * (the author, 2026-08-01: "why does this say file into book").
 *
 * So an OBSERVED label wins whenever one of them is the canonical word itself,
 * plural and casing intact. The invented broad term is reserved for the case it
 * was actually chosen for: genuinely different words merged onto a canonical
 * none of them used ("apparel" + "garment" -> "Clothing").
 */
function labelForKey(key: string, labels: Map<string, number> | undefined): string {
  if (labels) {
    let best: string | null = null;
    let bestCount = 0;
    for (const [label, count] of labels) {
      // comparable() strips case and plural, so "Books" matches key "book".
      if (comparable(label) === key && count > bestCount) {
        best = label;
        bestCount = count;
      }
    }
    // Their word, their casing. An all-lowercase label carries no intent, so it
    // is title-cased; anything with capitals is left exactly as written.
    if (best) return /[A-Z]/.test(best) ? best : displayCategory(best);
  }
  return displayCategory(key);
}

export function unifyCategories(raw: Array<string | null | undefined>): CategoryConsensus {
  const seen: string[] = [];
  const votes = new Map<string, number>();
  const order: string[] = [];
  /** Per canonical key, the ACTUAL labels filed under it and how often. */
  const labelsByKey = new Map<string, Map<string, number>>();
  for (const r of raw) {
    const label = (r ?? "").trim();
    if (label && !seen.includes(label)) seen.push(label);
    const key = normaliseCategory(r);
    if (!key) continue;
    if (!votes.has(key)) {
      order.push(key);
      labelsByKey.set(key, new Map());
    }
    votes.set(key, (votes.get(key) ?? 0) + 1);
    if (label) {
      const m = labelsByKey.get(key)!;
      m.set(label, (m.get(label) ?? 0) + 1);
    }
  }
  if (votes.size === 0) return { suggestion: null, unanimous: false, seen };
  let best = order[0]!;
  for (const k of order) if ((votes.get(k) ?? 0) > (votes.get(best) ?? 0)) best = k;
  return { suggestion: labelForKey(best, labelsByKey.get(best)), unanimous: votes.size === 1, seen };
}
