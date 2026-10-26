// Counting things whose noun is DATA, not a word somebody typed.
//
// `${n} ${noun}${n === 1 ? "" : "s"}` is right whenever the author wrote the
// noun themselves - "3 files", "1 bed" - and there are ~180 of those in this
// repo that are all fine. It goes wrong the moment the noun comes from a
// workspace: an instance display name, a user's own label, a bundle's item
// noun. A dashboard card read
//
//   18 inventorys
//
// because the Inventory instance has no item_noun, so the fallback singularised
// its display name and stuck an "s" on the end.
//
// This is only the small set of English rules that a NOUN needs. It is not a
// general inflector and deliberately does not try to be: irregulars belong in
// the data (`item_noun`), where the person who knows the word can say it.

import { quantityNumber } from "@cobblr/platform-contract/quantity-number";

/** Plural of a noun, by the rules that cover almost every count noun. */
export function pluralise(noun: string): string {
  const n = noun.trim();
  if (!n) return n;
  const lower = n.toLowerCase();

  // ANYTHING ALREADY ENDING IN "s" IS LEFT ALONE, and that is a decision, not
  // an oversight. English cannot tell "parts" (plural) from "lens" (singular)
  // without a dictionary: both are consonant + s. Adding "es" to be safe gives
  // "partses" the moment somebody's noun is already plural, which is the more
  // likely case for a label typed into a workspace. Leaving it gives "2 lens",
  // which is mildly wrong and instantly fixable by setting `item_noun`.
  // The one unambiguous exception: no plural ends in "-ss", so "pass",
  // "glass" and "class" are singulars and take -es (a laser station said
  // "2 pass").
  if (/ss$/.test(lower)) return `${n}es`;
  if (/s$/.test(lower)) return n;
  // x / z / ch / sh genuinely need -es and are unambiguous.
  if (/(?:x|z|ch|sh)$/.test(lower)) return `${n}es`;

  // consonant + y -> ies. "inventory" -> "inventories", "category" ->
  // "categories". A vowel before the y keeps it: "day" -> "days".
  if (/[^aeiou]y$/.test(lower)) return `${n.slice(0, -1)}ies`;

  return `${n}s`;
}

/** A word and its plural as somebody declared them (a bundle's noun offer,
 *  a unit vocabulary entry). `plural` absent means the regular rules. */
export interface CountWords {
  singular: string;
  plural?: string | null;
}

/** The word a count takes: 1 (or a change of -1) is singular, everything
 *  else (0, 3, 1.5) is plural, and a declared plural beats the rules. */
export function wordForCount(n: number, words: string | CountWords): string {
  const w = typeof words === "string" ? { singular: words } : words;
  const singular = w.singular.trim();
  if (Math.abs(n) === 1) return singular;
  return w.plural?.trim() || pluralise(singular);
}

/** "1 part" / "2 parts", "1 hank" / "3 hanks". A count and its word always
 *  agree, whether the word is typed text or a declared pair. */
export function countOf(n: number, noun: string | CountWords): string {
  return `${n} ${wordForCount(n, noun)}`;
}

/** The declared pair a stored word belongs to, matched on either form ("hank"
 *  or "hanks" both find hank/hanks), else the word itself as a singular. A
 *  unit is stored as whatever was typed, so the plural has to be found. */
export function countWordsFor(raw: string, known: readonly CountWords[] = []): CountWords {
  const q = raw.trim().toLowerCase();
  for (const k of known) {
    if (k.singular.trim().toLowerCase() === q || (k.plural ?? "").trim().toLowerCase() === q) {
      return { singular: k.singular.trim(), plural: k.plural?.trim() || null };
    }
  }
  return { singular: raw.trim() };
}

/** A quantity with its unit, wherever a sentence says one ("Added Wool (3
 *  hanks)"). A measured unit the vocabulary knows reads as its symbol ("750
 *  g"); a counted one agrees with the number, from the vocabulary's own words,
 *  else the table's declared words (`known`), else the regular rules.
 *  Callers preserving fine remainders can pass their stored precision. */
export function quantityWithUnit(
  n: number,
  raw: string | null | undefined,
  resolved?: { symbol: string; name: string; plural: string; category: string; factor?: number | null } | null,
  known: readonly CountWords[] = [],
  fractionDigits = 3,
): string {
  const num = quantityNumber(n, fractionDigits);
  const typed = (raw ?? "").trim();
  if (!typed) return num;
  if (resolved && resolved.category !== "count") return `${num} ${resolved.symbol}`;
  const words = resolved ? { singular: resolved.name, plural: resolved.plural } : countWordsFor(typed, known);
  return `${num} ${wordForCount(n, words)}`;
}

/**
 * A noun for the THINGS INSIDE a container, from whatever names are to hand.
 *
 * The order is by how much each source actually knows:
 *   1. an explicit `item_noun` - somebody said, so use their word
 *   2. the entity kind's own suffix (`vehicles:car` -> "car")
 *   3. "item"
 *
 * A container's DISPLAY NAME is deliberately not in that list. "Inventory",
 * "Wardrobe", "Bookshelf" and "Pantry" are all names for the container, and
 * none of them is what one thing inside is called. Singularising them produced
 * "18 inventorys", and "18 inventories" would have been just as wrong: an
 * inventory holds items, it is not a pile of inventories.
 */
export function itemNounFor(opts: {
  itemNoun?: string | null | undefined;
  entityKind?: string | null | undefined;
}): string {
  const declared = opts.itemNoun?.trim();
  if (declared) return declared;
  const tail = (opts.entityKind ?? "").split(":")[1]?.trim();
  // "item" is the literal suffix every instance kind carries (`vehicles:item`),
  // so it tells us nothing the fallback does not already say.
  if (tail && tail !== "item") return tail.replace(/[_-]/g, " ");
  return "item";
}

// Letters whose NAME starts with a vowel sound: "an SKU", "an FDM printer",
// "an HDMI cable", but "a USB stick" and "a PLA spool".
const VOWEL_SOUND_LETTERS = new Set(["a", "e", "f", "h", "i", "l", "m", "n", "o", "r", "s", "x"]);

/** "a" or "an" for a noun that is data (an order, a spool, an Inventory),
 *  by the sound it starts with. Like `pluralise`, it is the small set of
 *  rules a noun needs, not a dictionary: an unusual word reads as its
 *  spelling suggests ("a unicorn", "an umbrella", "an hour"). */
export function articleFor(noun: string): "a" | "an" {
  const word = noun.trim().split(/\s+/)[0] ?? "";
  if (!word) return "a";
  const lower = word.toLowerCase();
  // A number: "an 8", "an 11-piece set", "an 18mm socket"; every other number
  // starts with a consonant sound.
  if (/^\d/.test(word)) return /^(8|11(?!\d)|18(?!\d))/.test(word) ? "an" : "a";
  // An initialism is read letter by letter: "an SKU", "a USB stick".
  if (word.length > 1 && word.length <= 5 && word === word.toUpperCase() && /^[A-Z]+$/.test(word)) {
    return VOWEL_SOUND_LETTERS.has(lower[0]!) ? "an" : "a";
  }
  // Silent h.
  if (/^(hour|honest|honou?r|heir)/.test(lower)) return "an";
  // A vowel read as a consonant: "a unit", "a user", "a euro", "a one-off".
  if (/^(u[bcdfgjklmnpqrstvz][aeiou]|eu|ewe|one\b|once)/.test(lower) && !/^(un[^i]|under|umb|up|us$)/.test(lower)) return "a";
  return /^[aeiou]/.test(lower) ? "an" : "a";
}

/** The noun with its article: "an order", "a spool", "an Inventory". */
export function withArticle(noun: string): string {
  const n = noun.trim();
  return n ? `${articleFor(n)} ${n}` : n;
}
