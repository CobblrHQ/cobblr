// Freeform-capture location extraction. A typed/dictated note like
// "Logic analyzer in cabinet 002" or "Dial calipers have been placed in
// Tool Chest 001" carries BOTH the item and where it went. This splits the
// two and resolves the location phrase against the workspace's existing
// core-locations, so the captured item lands pre-filed instead of having the
// whole sentence become the item name.
//
// Pure + deterministic (no LLM) so it's fast, unit-testable, and predictable:
// the caller fetches the location list (cross-module, via platform().entities)
// and hands it in. Conservative by design — a phrase only becomes a location
// when it RESOLVES to a real location, or looks unmistakably like a container
// (a container word + an identifier), so ordinary names ("Pumpkin in a can")
// aren't mangled.

export interface LocationLite {
  id: string;
  name: string;
  short_name?: string | null;
}

export interface LocationExtraction {
  /** The note text with the location phrase removed (the item name). Falls
   *  back to the original text when nothing location-like was found. */
  itemText: string;
  /** Resolved core-locations id, when the phrase matched an existing location. */
  locationId: string | null;
  /** The raw phrase we detected (e.g. "cabinet 002") — stamped as scan_area
   *  when it didn't resolve, so the location is still captured as a hint. */
  locationPhrase: string | null;
  /** The matched location's display name, when resolved. */
  matchedName: string | null;
}

// Words that, paired with an identifier, mark a phrase as a physical location
// even if it isn't in the workspace yet (so a fresh workspace still captures
// "...in bin 135" as a location hint rather than swallowing it into the name).
const CONTAINER_WORDS = [
  "bin", "cabinet", "shelf", "drawer", "chest", "box", "rack", "tote", "case",
  "cubby", "slot", "tray", "locker", "container", "compartment", "pallet",
  "room", "shelf", "cart", "crate", "pegboard",
];

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
// "bin 0087" and "bin 87" should match — drop leading zeros inside numbers.
const stripZeros = (s: string): string => s.replace(/\b0+(\d)/g, "$1");

/** Pull a trailing "<item> <preposition> <location>" phrase out of a note and
 *  resolve it against `locations`. */
export function extractLocation(textIn: string, locations: LocationLite[]): LocationExtraction {
  const text = (textIn ?? "").trim();
  const none: LocationExtraction = { itemText: text, locationId: null, locationPhrase: null, matchedName: null };
  if (!text) return none;

  // "<item> [has been|is|was] [placed|put|stored|...] (in|into|on|at|under) <loc>"
  const prepositional = text.match(
    /^(.*?\S)\s+(?:(?:has|have|is|are|was|were)\s+)?(?:been\s+)?(?:placed|put|stored|located|kept|filed|stashed|sitting|set|live[sd]?|go(?:es)?|belongs?)?\s*\b(?:in|into|inside|on|at|under)\b\s+(.+?)[.!]*$/i,
  );
  // "<item> @ <loc>" / "<item> -> <loc>"
  const arrow = text.match(/^(.*?\S)\s*(?:@|->|→)\s*(.+?)[.!]*$/);

  let itemText = text;
  let phrase: string | null = null;
  if (prepositional && prepositional[1] && prepositional[2]) {
    itemText = prepositional[1].trim();
    phrase = prepositional[2].trim();
  } else if (arrow && arrow[1] && arrow[2]) {
    itemText = arrow[1].trim();
    phrase = arrow[2].trim();
  }
  if (!phrase) return none;

  // Resolve against existing locations: exact (name/short_name), then
  // zero-insensitive, then a contains match either direction.
  const pN = norm(phrase);
  const pZ = stripZeros(pN);
  let match: LocationLite | null = null;
  for (const loc of locations) {
    const names = [loc.name, loc.short_name ?? ""].filter(Boolean).map(norm);
    if (names.some((n) => n === pN || stripZeros(n) === pZ)) {
      match = loc;
      break;
    }
  }
  if (!match) {
    for (const loc of locations) {
      const n = norm(loc.name);
      if (n.length >= 3 && (pN === n || pN.includes(n) || n.includes(pN))) {
        match = loc;
        break;
      }
    }
  }

  if (match) {
    return { itemText: itemText || text, locationId: match.id, locationPhrase: phrase, matchedName: match.name };
  }

  // Unresolved — only keep it as a location hint when it's unmistakably a
  // container (a container word AND some identifier), so we don't strip a real
  // part of the item name on a false "in".
  const looksLikeContainer =
    CONTAINER_WORDS.some((w) => new RegExp(`\\b${w}\\b`, "i").test(phrase!)) &&
    /[0-9a-z]/i.test(phrase!.replace(new RegExp(`\\b(?:${CONTAINER_WORDS.join("|")})\\b`, "ig"), "").trim());
  if (looksLikeContainer) {
    return { itemText: itemText || text, locationId: null, locationPhrase: phrase, matchedName: null };
  }
  return none;
}
