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
  if (/s$/.test(lower)) return n;
  // x / z / ch / sh genuinely need -es and are unambiguous.
  if (/(?:x|z|ch|sh)$/.test(lower)) return `${n}es`;

  // consonant + y -> ies. "inventory" -> "inventories", "category" ->
  // "categories". A vowel before the y keeps it: "day" -> "days".
  if (/[^aeiou]y$/.test(lower)) return `${n.slice(0, -1)}ies`;

  return `${n}s`;
}

/** "1 part" / "2 parts", with the noun kept as given. */
export function countOf(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun.trim() : pluralise(noun)}`;
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
