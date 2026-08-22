// An id is how Cobb finds a thing. It is not something to say to a person.
//
// Asked about two racks, he answered "positioned under the same parent location
// (67377d87-7070-4f5d-87cd-603501d18130)". Every word of that is true and the
// last of it is unreadable: nobody has ever wanted the uuid of their shelf. The
// model sees ids because its tools return them, it needs them to act, so
// telling it not to repeat them is necessary and not sufficient. This is the
// part that does not depend on the model complying.
//
// Replace when we know the name (the tools that returned the id also returned
// what it is called), remove when we do not. Removing is safe: a sentence that
// still reads without the id was never carrying information for the reader.

/** A uuid, the only id shape the platform hands out. Deliberately narrow: this
 *  runs on prose, and a looser pattern would eat serial numbers, part codes and
 *  anything else a workshop legitimately writes down. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HOLE = "\u0000";

export function containsId(text: string): boolean {
  UUID.lastIndex = 0;
  return UUID.test(text);
}

/**
 * Take the ids out of an answer.
 *
 * `names` maps id to what it is called, gathered from the turn's tool results.
 * A known id becomes its name. An unknown one is cut along with the empty
 * parenthesis or bracket it was sitting in, because "()" left behind reads as
 * a mistake rather than as tact.
 */
export function scrubIds(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  if (!text) return text;
  let out = text.replace(UUID, (id) => names.get(id.toLowerCase()) ?? HOLE);
  // A model that writes "**Den** (67377d87-…)" ends up with "**Den** (Den)"
  // once the id becomes its name. The bracket was there to identify the thing;
  // the name already did that, so the bracket goes.
  for (const label of new Set(names.values())) {
    const l = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(${l})([*_\`]*)\\s*[([]\\s*${l}\\s*[)\\]]`, "gi"), "$1$2");
  }
  if (!out.includes(HOLE)) return out;
  const hole = new RegExp(HOLE, "g");
  out = out
    // A removed id inside brackets takes the brackets with it, and the space
    // that introduced them: "location (X)." becomes "location."
    .replace(new RegExp("\\s*[([]\\s*" + HOLE + "\\s*[)\\]]", "g"), "")
    .replace(new RegExp("\\s*" + HOLE + "\\s*", "g"), " ")
    .replace(hole, "")
    .replace(/[ \t]{2,}/g, " ")
    // A sentence that ended with the id keeps its full stop, not " ."
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  return out;
}

/** id to label, from whatever the tools returned this turn. Shapes vary by tool
 *  (`items`, a bare record, a list), so this reads defensively rather than
 *  trusting one of them. */
export function namesFromToolResults(results: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>();
  const visit = (v: unknown, depth = 0): void => {
    if (!v || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const rec = v as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : null;
    const label =
      typeof rec.name === "string" ? rec.name
      : typeof rec.title === "string" ? rec.title
      : typeof rec.label === "string" ? rec.label
      : null;
    if (id && label) names.set(id.toLowerCase(), label);
    for (const x of Object.values(rec)) visit(x, depth + 1);
  };
  visit(results);
  return names;
}
