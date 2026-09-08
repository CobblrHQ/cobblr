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
  for (const seen of seenNames.values()) {
    if (norm(seen) !== wanted) continue;
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
