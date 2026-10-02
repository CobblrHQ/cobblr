// The facts a hint states in its own shape, read before any model is asked.
//
// "8x s-12415" means eight of the S-12415 (a supplier part number). It went to
// the vision model as prose, which kept the name it had, chose no photo and
// left the count at one (core#4552). A count and a part number have shapes:
// read them as such, and let the model see only what is left.
import { typedIdentifier } from "./intake.js";

export interface HintFacts {
  /** "8x", "x8", "8 ×", "qty 8", "8 pcs": how many there are. */
  quantity: number | null;
  /** A model, part or serial number, or a product code ("S-12415"). */
  identifier: string | null;
  /** Whether the identifier is a code the catalogs key on (a UPC, an ISBN)
   *  rather than a part number the web is asked about. */
  identifierKind: "code" | "identifier" | null;
  /** The words left once the count and the identifier are taken out. */
  rest: string;
}

const MAX_COUNT = 100_000;

// Whole tokens only: "M8x20" is a part number, never eight of a 20.
const COUNT_PATTERNS: RegExp[] = [
  /^(\d{1,6})\s*(?:x|×)$/i, // 8x, 8 ×
  /^(?:x|×)\s*(\d{1,6})$/i, // x8
  /^(\d{1,6})\s*(?:pcs?|pieces?|ea|units?)$/i, // 8pcs, 8 pc
];

function countOf(token: string): number | null {
  for (const re of COUNT_PATTERNS) {
    const m = re.exec(token);
    if (m) return bounded(Number(m[1]));
  }
  return null;
}

function bounded(n: number): number | null {
  return Number.isInteger(n) && n >= 1 && n <= MAX_COUNT ? n : null;
}

export function parseHintFacts(hint: string | null | undefined): HintFacts {
  const none: HintFacts = { quantity: null, identifier: null, identifierKind: null, rest: (hint ?? "").trim() };
  let text = (hint ?? "").trim();
  if (!text) return none;
  let quantity: number | null = null;

  // Two-token counts first ("8 x", "x 8", "qty 8", "8 pcs", "8 ×"), then
  // single tokens.
  const spaced = [
    /(?:^|\s)(?:qty|quantity|count)\s*[:=]?\s*(\d{1,6})(?=\s|$)/i,
    /(?:^|\s)(\d{1,6})\s+(?:x|×|pcs?|pieces?|units?|of)(?=\s|$)/i,
    /(?:^|\s)(?:x|×)\s+(\d{1,6})(?=\s|$)/i,
  ];
  for (const re of spaced) {
    const m = re.exec(text);
    if (m) {
      quantity = bounded(Number(m[1]));
      if (quantity != null) text = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).trim();
      break;
    }
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  let identifier: string | null = null;
  let identifierKind: HintFacts["identifierKind"] = null;
  for (const tok of tokens) {
    const bare = tok.replace(/^[("']+|[)"',;:.!?]+$/g, "");
    if (quantity == null) {
      const n = countOf(bare);
      if (n != null) {
        quantity = n;
        continue;
      }
    }
    if (!identifier) {
      const typed = typedIdentifier(bare);
      if (typed) {
        identifier = typed.kind === "identifier" ? bare.toUpperCase() : typed.code;
        identifierKind = typed.kind;
        continue;
      }
    }
    kept.push(tok);
  }
  return { quantity, identifier, identifierKind, rest: kept.join(" ").trim() };
}
