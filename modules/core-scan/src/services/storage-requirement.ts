// How a product must be KEPT — which is not the same fact as where it is.
//
// "Requires refrigeration" is a property of the product, read off the label.
// "In the fridge" is where this particular one happens to be, and that belongs
// to core-locations. Conflating them is how a `storage` field ends up with
// choices like "Fridge | Pantry | Counter | Spice rack", which answers the
// second question while being named for the first.
//
// WHY THIS IS DERIVED FROM CATEGORY, having measured the alternatives on a real
// 221-item scan set:
//
//   photo observations   6/221 mention storage at all (2.7%), and two of the
//                        six were a 3D printer matching "cool" and a receipt
//                        matching "store". Real hit rate under 2%.
//   OFF conservation     sparsely populated, free prose, multilingual, and
//                        sometimes NEGATIVE - Nutella, one of the best-populated
//                        products in the database, says "Ne pas mettre au
//                        réfrigérateur". Parsing that reliably is a language
//                        problem attached to a mostly-empty field.
//   category             162/221 (73%), already retained on the scan row, and
//                        already the input to an ordered-rules table in
//                        category-buckets.ts.
//
// A generic category returns NULL and that is correct, not a miss. "Groceries",
// "food" and "food/beverage" imply nothing about how a thing must be kept, and
// asserting "ambient" for them would be the same overreach as defaulting an
// unmatched category. Measured over 68 distinct categories from a real scan
// set, the residual unknowns are either non-food (Light Switches, Circuit
// Breaker Panels) or exactly those generic labels.
//
// Three values, not four. An earlier draft had "cool & dry" separate from
// "ambient", which reads well and buys nothing: no behaviour anywhere would
// differ between them. Frozen and refrigerated earn their place because getting
// them wrong spoils food.

export type StorageRequirement = "frozen" | "refrigerated" | "ambient";

/** Ordered, specific before general - the first hit wins, same discipline as
 *  category-buckets.ts. */
const RULES: Array<{ match: RegExp; requirement: StorageRequirement }> = [
  // Frozen first: "frozen pizza" must not be caught by the pizza/bakery rules,
  // and "ice cream" must not be caught by dairy.
  { match: /\bfrozen\b|ice cream|\bgelato\b|\bsorbet\b|frozen dessert|\bglaces?\b|surgel/, requirement: "frozen" },
  // SHELF-STABLE FORMS, before the chilled aisle. A product's form outranks its
  // ingredient: garlic powder is not garlic, milk powder is not milk, canned
  // fish is not fish. Without this rule "Garlic powder" fell through to no match
  // at all (Open Food Facts returns categories that granular - a real scan
  // set has "Garlic powder" and "Dried rosemary" as categories), and "milk
  // powder" would have been called refrigerated by the rule below.
  {
    match: /\bpowder\b|\bdried\b|dehydrated|freeze.?dried|\buht\b|long.?life|shelf.?stable|\bcanned\b|\btinned\b|\bjarred\b|\bpickled\b/,
    requirement: "ambient",
  },
  // Then the chilled aisle. `\bcream\b` is deliberately after ice cream above.
  {
    match: /\bdairy\b|\bmilk\b|yogh?urt|\bcheese\b|\bbutter\b|\bcream\b|creme fraiche|\beggs?\b|fresh meat|\bpoultry\b|\bfish\b|seafood|\bdeli\b|charcuterie|sausage|fresh pasta|\bhummus\b/,
    requirement: "refrigerated",
  },
  // Shelf-stable things worth asserting positively, so the common case is not
  // left unknown and therefore unusable.
  {
    match: /\bspice|seasoning|\bherb|\bsalt\b|\bpepper|\bsugar|\bflour\b|\btea\b|teas\b|tea bags|\bcoffee\b|\bcanned\b|\bjarred\b|\bpasta\b|\brice\b|\bcereal|dried|\bhoney\b|\bvinegar\b|baking|\bcocoa\b|\bcacao\b|\bsnacks?\b|\bextracts?\b|\bseeds?\b|\bnuts?\b|infusions?/,
    requirement: "ambient",
  },
];

/**
 * The requirement a category implies, or null when nothing does.
 *
 * NULL IS THE IMPORTANT RETURN. Defaulting an unmatched category to "ambient"
 * would assert that an uncategorised frozen item is shelf-stable, and anything
 * comparing requirement against actual location would then report a false
 * problem. Only claim a requirement when a rule actually fired; an absent
 * requirement is an honest "we do not know", and every consumer must treat it
 * as "say nothing" rather than as "ambient".
 */
export function storageRequirementFor(category: string | null | undefined): StorageRequirement | null {
  if (!category) return null;
  // Taxonomy paths ("Plant-based foods > Teas") reduce to their tail, lowercased,
  // the same normalisation category-buckets applies.
  const tail = (category.split(/[>/›»|]/).pop() ?? category)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!tail) return null;
  for (const rule of RULES) if (rule.match.test(tail)) return rule.requirement;
  return null;
}

/**
 * Does where it IS contradict how it must be KEPT?
 *
 * The one thing neither fact can answer alone, and the reason keeping them
 * apart is worth the trouble. Returns null when there is nothing to say -
 * unknown requirement, unknown location, or agreement - so a caller can only
 * ever act on a positive contradiction.
 */
export function storageMismatch(
  requirement: StorageRequirement | null | undefined,
  locationName: string | null | undefined,
): { requirement: StorageRequirement; location: string } | null {
  if (!requirement || requirement === "ambient" || !locationName) return null;
  const place = locationName.toLowerCase();
  const isFreezer = /freezer|deep ?freeze/.test(place);
  // A freezer satisfies a refrigeration requirement; a fridge does not satisfy
  // a frozen one.
  const isCold = isFreezer || /fridge|refrigerat|chiller|cool ?box/.test(place);
  if (requirement === "frozen" && isFreezer) return null;
  if (requirement === "refrigerated" && isCold) return null;
  return { requirement, location: locationName };
}
