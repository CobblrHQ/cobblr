// A small English inflector for deriving a collection's item noun from its
// name. When a user creates a "Films" collection, its item noun defaults to
// "Film" (singular) / "Films" (plural), so the UI reads "New Film", "search
// films", "No films yet" instead of inventory's hardcoded "part". This is a
// best-effort DEFAULT, surfaced + editable in the instance settings — the odd
// case ("Series", "Equipment", "Media") is one edit away, never a silent wrong
// guess that ships. See docs/design-decisions/one-record-substrate.md.
//
// Operates on the LAST word of a multi-word name (so "Board Games" → "Board
// Game") and preserves the leading case of that word.

const UNCOUNTABLE = new Set([
  "series",
  "species",
  "equipment",
  "information",
  "rice",
  "money",
  "fish",
  "sheep",
  "deer",
  "aircraft",
  "software",
  "hardware",
  "furniture",
  "luggage",
  "stock",
  "gear",
]);

const IRREGULAR_SINGULAR: Record<string, string> = {
  people: "person",
  men: "man",
  women: "woman",
  children: "child",
  teeth: "tooth",
  feet: "foot",
  mice: "mouse",
  geese: "goose",
  media: "medium",
  data: "datum",
};
const IRREGULAR_PLURAL: Record<string, string> = Object.fromEntries(
  Object.entries(IRREGULAR_SINGULAR).map(([p, s]) => [s, p]),
);

function withLeadingCase(sample: string, out: string): string {
  if (sample && sample[0] === sample[0]?.toUpperCase()) {
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out;
}

function splitLast(name: string): { head: string; last: string } {
  const trimmed = name.trim();
  const i = trimmed.lastIndexOf(" ");
  return i === -1
    ? { head: "", last: trimmed }
    : { head: trimmed.slice(0, i + 1), last: trimmed.slice(i + 1) };
}

/** Best-effort singular of a (possibly multi-word) collection name. */
export function singularize(name: string): string {
  const { head, last } = splitLast(name);
  if (!last) return name.trim();
  const lower = last.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return head + last;
  if (IRREGULAR_SINGULAR[lower]) return head + withLeadingCase(last, IRREGULAR_SINGULAR[lower]!);

  let s = last;
  if (/[^aeiou]ies$/i.test(last)) s = last.slice(0, -3) + "y"; // Categories → Category
  else if (/(ses|xes|zes|ches|shes)$/i.test(last)) s = last.slice(0, -2); // Boxes → Box
  else if (/ives$/i.test(last)) s = last.slice(0, -3) + "ife"; // Knives → Knife
  else if (/ves$/i.test(last)) s = last.slice(0, -3) + "f"; // Shelves → Shelf
  else if (/oes$/i.test(last)) s = last.slice(0, -2); // Potatoes → Potato
  else if (/(ss|us|is)$/i.test(last)) s = last; // Glass, Status, Axis — leave
  else if (/s$/i.test(last)) s = last.slice(0, -1); // Films → Film
  return head + s;
}

/** Best-effort plural of a (possibly multi-word) collection name. */
export function pluralize(name: string): string {
  const { head, last } = splitLast(name);
  if (!last) return name.trim();
  const lower = last.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return head + last;
  if (IRREGULAR_PLURAL[lower]) return head + withLeadingCase(last, IRREGULAR_PLURAL[lower]!);

  let p = last;
  if (/[^aeiou]y$/i.test(last)) p = last.slice(0, -1) + "ies"; // Category → Categories
  else if (/(s|x|z|ch|sh)$/i.test(last)) p = last + "es"; // Box → Boxes, Watch → Watches
  else if (/fe$/i.test(last)) p = last.slice(0, -2) + "ves"; // Knife → Knives
  else if (/[^aeiou]f$/i.test(last)) p = last.slice(0, -1) + "ves"; // Shelf → Shelves
  else p = last + "s"; // Film → Films
  return head + p;
}
