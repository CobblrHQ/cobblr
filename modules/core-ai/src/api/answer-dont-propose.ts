// Asked how much of something there is, it offered to make one.
//
//   "how much do I have of the black yarn"
//     -> list_records yarn:item q=black   (the Yarn list: only the blue one)
//     -> create_record "Black yarn"
//
// The workspace had four of it, as a part in plain Inventory, and the person
// got a card offering to add a Black yarn instead of a number. Nine asks in a
// row on the live bench (2026-09-16), so this is a shape, not noise: the
// model looked in one table, found nothing, and reached for a write.
//
// A question about what the person HAS is answered from what was found, or
// with "nothing matched", and never with a proposal: nothing they said asked
// for a change. This is a guard in the shape of move-not-create: the write is
// handed back once, before a card exists, with the reason, and the model
// answers again. The prompt already says to answer questions; a guard is what
// holds when the model does not.
//
// NARROW on purpose. It fires only on a question whose SHAPE is a read of
// their data (how much / how many / do I have / is there / where is / what do
// I have). "Can you add a part called X?" is a question by its first word and
// an instruction by its meaning, and it is left alone. So is a question that
// carries a code to look up ("where is my parcel, tracking 1Z999..."): the
// answer to that IS an action, and the corpus test below keeps it so.
import type { ToolCall } from "../providers/tool-wire.js";

/** A question about what the workspace holds: a count, a presence, a place. */
const ASKS_ABOUT_MY_DATA =
  /^\s*(how (much|many)\b|do (i|we) (have|own|still have)\b|(is|are) there\b|what do (i|we) have\b|what (have i|have we) got\b|where (is|are|did|'s|s)\b|which \w+ (do i|do we|did i|is|are)\b|any \w+ left\b)/i;

/** ...unless it hands over something to look up outside the workspace: a
 *  tracking number, a code, an order. Answering that is a lookup action. */
const CARRIES_A_LOOKUP = /\b(tracking|track|shipment|parcel|package|order)\b.*\b[A-Z0-9]{8,}\b|\b[A-Z0-9]{10,}\b/;

/** The writes a question is never answered with. */
const A_WRITE = /^(create|update|delete)_record$|^invoke_action$/;

export function asksAboutMyData(userText: string): boolean {
  return ASKS_ABOUT_MY_DATA.test(userText) && !CARRIES_A_LOOKUP.test(userText);
}

/** The message to hand back, or null when the call is fine as written. */
export function answeredNotProposed(userText: string, call: Pick<ToolCall, "name">): string | null {
  if (!A_WRITE.test(call.name)) return null;
  if (!asksAboutMyData(userText)) return null;
  const verb = call.name === "invoke_action" ? "run an action" : call.name.replace(/_record$/, " a record");
  return (
    `That was a question about what they have, and you are about to ${verb}. ` +
    `A question is answered in words: say what you found (the record, its count, where it is), ` +
    `or that nothing matched, after looking wherever it could be filed (search_records looks ` +
    `across every table). Do not propose a change unless they ask for one.`
  );
}
