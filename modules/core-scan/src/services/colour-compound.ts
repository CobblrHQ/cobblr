/** Colour words that are part of WHAT THE THING IS, not what colour it is.
 *
 *  Green tea is not tea that happens to be green. Brown sugar, black pepper,
 *  pink salt, white chocolate, red onion: in each the colour word names the
 *  variety, and swapping it produces a different product or a nonsense one.
 *
 *  This matters because `nameWithColor` REPLACES a colour word in the name when
 *  it disagrees with the item's colour field, on the sound reasoning that a
 *  title still carrying the OLD colour after a correction is worse than none.
 *  Sound for "UA Icon T-Shirt, Blue" corrected to black. Ruinous for "Ginger
 *  Peach Green Tea" in a red box, which becomes "Ginger Peach Red Tea".
 *
 *  MEASURED, not assumed. Of 195 real scanned items, 48 carry a colour word in
 *  the name, and every one of them is this case: Green Tea, Dark Brown Sugar,
 *  Whole Black Peppercorns, Himalayan Pink Salt, Blue Agave, Premier White
 *  Morsels, Ground Red Pepper. Not one was a colour description. So on a
 *  grocery-heavy inbox the substitution branch is wrong roughly a quarter of
 *  the time it can fire.
 *
 *  It is a lexical fact about retail English, not a use case, which is why a
 *  list is the honest implementation rather than something cleverer: "green
 *  tea" and "green mug" are structurally identical and only a vocabulary tells
 *  them apart. Incomplete by nature — and a missing entry costs a SUBSTITUTION
 *  (the unlisted compound reads as a mere colour and gets rewritten), which is
 *  the destructive direction. When a variety compound loses its word to a
 *  detected colour, the fix is another entry here. */

/** `<colour> <noun>` pairs where the colour is part of the variety. Stored as
 *  the noun that follows, per colour, so a match is one lookup. */
const COMPOUND_NOUNS: Record<string, string[]> = {
  green: ["tea", "beans", "bean", "onion", "onions", "olives", "olive", "pepper", "peppers", "curry", "chilli", "chili"],
  black: ["tea", "pepper", "peppercorn", "peppercorns", "beans", "bean", "olives", "olive", "coffee", "pudding", "sesame", "garlic", "rice"],
  white: ["chocolate", "sugar", "rice", "bread", "wine", "vinegar", "pepper", "onion", "onions", "morsels", "beans", "bean", "tea", "noise"],
  brown: ["sugar", "rice", "bread", "sauce", "sesame", "butter", "mustard"],
  red: ["pepper", "peppers", "onion", "onions", "wine", "meat", "curry", "chilli", "chili", "lentils", "cabbage", "beans", "bean"],
  blue: ["cheese", "agave", "corn"],
  yellow: ["mustard", "curry", "onion", "onions", "split", "corn"],
  pink: ["salt", "peppercorn", "peppercorns", "lemonade", "grapefruit"],
  orange: ["juice", "zest", "peel", "blossom", "marmalade"],
  purple: ["cabbage", "corn"],
  gold: ["leaf"],
  silver: ["leaf"],
  grey: ["salt", "poupon"],
  gray: ["salt"],
};

/** Is `colour`, as it appears in `name`, part of the product's variety?
 *
 *  True when the colour word is immediately followed by a noun that forms a
 *  known compound. Position matters: "Black Peppercorns" is the variety, while
 *  "Peppercorn Grinder, Black" is a description of the grinder. */
export function isVarietyColour(name: string | null | undefined, colour: string | null | undefined): boolean {
  const n = (name ?? "").toLowerCase();
  const c = (colour ?? "").trim().toLowerCase();
  if (!n || !c) return false;
  const nouns = COMPOUND_NOUNS[c];
  if (!nouns) return false;
  // The word immediately after this colour, wherever it appears.
  const m = new RegExp(`\\b${c}\\b[\\s-]+([a-z]+)`, "i").exec(n);
  if (!m) return false;
  return nouns.includes((m[1] ?? "").toLowerCase());
}
