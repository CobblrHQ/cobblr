// Asked to MOVE something, it made a second one.
//
//   "move all the tea from this page into the Tea section"
//     -> list_records
//     -> create_record "Celestial seasonings Lemon Zinger Herbal Tea"
//     -> create_record "Tazo Tea Wild Sweet Orange"
//     -> "I've moved the tea items ... directly into your Tea section for you!"
//
// Two of the five tea items on that page now existed twice, the copies had
// none of the photo, location, quantity or label history the originals carry,
// and the sentence said the opposite of what happened (2026-09-08, reported
// with a screenshot).
//
// A section here is a promoted category: platform:promote-category says
// "records keep their ids, their history and their printed labels; only which
// list they are in changes". So a move is an UPDATE, always. There is no
// reading of "move" that create_record satisfies.
//
// The loop already knows every record name it read this turn - it keeps them
// to turn ids back into names in the answer. That is exactly what is needed
// here: creating a record with a name the model has just been shown, while
// being asked to move something, is the mistake, and it can be caught before
// anything is written.
//
// NARROW on purpose. It fires only when the ask is a move, not an add: "add 3
// spools of black PLA" to a workspace that already has black PLA is a real
// create, and a second jar of turmeric is a second jar of turmeric.
//
// The other end of a move is the place it goes, and a stranger met that one
// (2026-09-20, #3255): "move the multimeter to bin 4" when there was no Bin 4
// read the locations three times, then proposed a create for Bin 4 and said
// nothing. The person confirmed a card that made a bin and moved nothing.
// Asked again on a throwaway (2026-09-21) the same model read the six
// locations, found no Bin 4, and placed the multimeter in Bin 1 with nothing
// said. Both are one mistake: a destination that is not there was acted on
// as if it were. It is a question ("Bin 4 is not there; make it and move the
// Multimeter in?"), never a silent create and never a substitute place; and
// a destination that IS there is where the thing goes, never a second copy.

import type { ToolCall } from "../providers/tool-wire.js";

/** Move, in the senses that mean "the thing already exists". */
const A_MOVE =
  /\b(move|moves|moved|moving|relocate|relocates|relocated|transfer|transferred|reassign|refile|re-file|file|files|filed|shift|shifted)\b/i;

/** ...but "file a copy of" and "move on" are not that. */
const NOT_A_MOVE = /\b(move on|moving on|file a copy|make a copy|duplicate)\b/i;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The name a create call is about to write. */
export function createdName(call: ToolCall): string | null {
  if (call.name !== "create_record") return null;
  const args = (call.args ?? {}) as Record<string, unknown>;
  const fields = (args.fields ?? args) as Record<string, unknown>;
  for (const key of ["name", "title", "label"]) {
    const v = fields[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** The words that put a moved thing somewhere: what follows them is where. */
const INTO = "(?:to|into|in|inside|onto|on|under)";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The name, as a pattern that forgives spacing and case. */
const namePattern = (name: string): string => escapeRe(name.trim()).replace(/\s+/g, "\\s+");
const ARTICLE = "(?:the\\s+|my\\s+|a\\s+)?";

/** Where they said it goes, in their words ("bin 4"), or null when the
 *  sentence does not say. */
export function destinationIn(userText: string): string | null {
  const m = new RegExp(`\\b${INTO}\\s+${ARTICLE}([^.!?,;]+?)\\s*(?:[.!?,;].*)?$`, "i").exec(userText);
  // "the shelf in the garage" is the shelf; the rest says where the shelf is.
  const dest = m?.[1]?.trim().split(/\s+(?:in|inside|on|under|of|at|next to|beside)\s+/i)[0]?.trim();
  return dest ? dest : null;
}

/** True when the person's words name this as where the thing goes. */
export function isDestination(userText: string, name: string): boolean {
  return new RegExp(`\\b${INTO}\\s+${ARTICLE}${namePattern(name)}\\b`, "i").test(userText);
}

/** What they asked to move, in their words ("the multimeter"), or "it". */
export function movedThing(userText: string, destination: string): string {
  const m = new RegExp(`${A_MOVE.source}\\s+(.+?)\\s+${INTO}\\s+${ARTICLE}${namePattern(destination)}\\b`, "i").exec(userText);
  const thing = m?.[2]?.trim().replace(/^(all\s+(of\s+)?)?(the|my|this|that|these|those)\s+/i, "");
  return thing ? thing : "it";
}

/** A read label that is the destination, near enough: "electronics bin" for
 *  "the electronics bin", "Tea" for "the Tea section". Loose on purpose; a
 *  false match only makes the guard quieter. */
const namesThePlace = (label: string, dest: string): boolean => {
  const a = norm(label);
  const b = norm(dest);
  const within = (part: string, whole: string): boolean => new RegExp(`(^|\\s)${escapeRe(part)}(\\s|$)`).test(whole);
  return a.length > 1 && (a === b || within(a, b) || within(b, a));
};

/** The record a write puts the thing INTO, when the write is a placement:
 *  the container of a place action, or a location field of an update. */
export function placedInto(call: ToolCall): string | null {
  const args = (call.args ?? {}) as Record<string, unknown>;
  const fields = (call.name === "invoke_action" ? args.args : call.name === "update_record" ? args.fields : null) as Record<string, unknown> | null | undefined;
  if (!fields || typeof fields !== "object") return null;
  for (const key of ["container_id", "location_id", "parent_id", "target_container_id", "target_location_id"]) {
    const v = fields[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** The message to hand back, or null when the call is fine as written. */
export function movedNotCreated(
  userText: string,
  call: ToolCall,
  seenNames: ReadonlyMap<string, string>,
): string | null {
  if (!A_MOVE.test(userText) || NOT_A_MOVE.test(userText)) return null;
  const name = createdName(call);
  if (!name) return null;
  const wanted = norm(name);
  for (const [id, seen] of seenNames) {
    if (norm(seen) !== wanted) continue;
    if (isDestination(userText, name)) {
      const thing = movedThing(userText, name);
      return (
        `"${seen}" already exists - you read it a moment ago (its id is ${id}), and it is where they asked you to move ${thing}. ` +
        `Creating a second "${seen}" makes a duplicate place and moves nothing. ` +
        `Put ${thing} into the "${seen}" you were shown instead: run the action that places it there, or update ${thing}'s record. ` +
        `Never create something you have just been shown.`
      );
    }
    return (
      `"${seen}" already exists - you read it a moment ago, and they asked you to MOVE it. ` +
      `Creating a record with that name makes a second copy and leaves the original where it was, ` +
      `with its photo, its place, its quantity and its printed label still on the one nobody can see. ` +
      `Move it instead: update that record (or run the action that files it), and never create ` +
      `something you have just been shown. If you genuinely meant to add a NEW thing that happens to ` +
      `share the name, say so in your answer.`
    );
  }
  return null;
}

/** Asked to move something INTO a place it did not find, and about to act
 *  as if it had: create the place with nothing said, or put the thing
 *  somewhere else. Null when the call is not that. Runs after
 *  movedNotCreated, which owns the case where the place was read. */
export function destinationNotThere(
  userText: string,
  call: ToolCall,
  seenNames: ReadonlyMap<string, string>,
): string | null {
  if (!A_MOVE.test(userText) || NOT_A_MOVE.test(userText)) return null;
  const dest = destinationIn(userText);
  if (!dest) return null;
  for (const seen of seenNames.values()) if (namesThePlace(seen, dest)) return null;
  const thing = movedThing(userText, dest);
  const name = createdName(call);
  if (name) {
    if (!namesThePlace(name, dest)) return null;
    return (
      `"${name}" is where they asked you to move ${thing}, and it is not among the records you have read this turn. ` +
      `If you have not looked, look for it first (list or search the locations). ` +
      `If it is not there, do not make it without a word: a card that creates "${name}" and moves nothing is not what they asked for, ` +
      `and the person would see a create with nothing said. Answer in words instead: say "${name}" does not exist, ` +
      `and ask whether to make it and move ${thing} in. If they say yes, create "${name}" first; once it exists, move ${thing} into it.`
    );
  }
  const into = placedInto(call);
  if (!into) return null;
  const label = seenNames.get(into);
  return (
    `They asked you to move ${thing} to "${dest}", and nothing you have read this turn is called that` +
    (label ? `; this would put ${thing} in "${label}" instead, which is not what they asked for. ` : `; this puts ${thing} somewhere you have not read. `) +
    `Do not substitute a place. If you have not looked, look for "${dest}" first (list or search the locations). ` +
    `If it is not there, answer in words: say "${dest}" does not exist, and ask whether to make it and move ${thing} in, ` +
    `or which of the places that do exist to use.`
  );
}
