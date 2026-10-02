// Which model plans a turn: the chat model, or the fuller one a change gets.
//
// "Delete this and yarn as a whole" was planned by Flash Lite, the cheap
// model a free workspace chats with: one change of the two, and a card that
// contradicted itself. A plan that deletes a record or reshapes the workspace
// is a serious action, so it is made by each provider's fuller model, the
// `plan-changes` job (the contract says what that maps to), on the same busy
// ladder, never stepping down to the light one (#4574).
//
// Two ways a turn gets there. The message asks for such a change ("delete
// this", "turn off Yarn", "make a Mugs list and file these in it"): the turn
// starts on it. Or the words did not say so and the model's round proposes
// one anyway: that round is asked again of the fuller model before anything
// is offered, and the rest of the turn stays there. A question stays on the
// chat model, which is the whole point of having two.

import type { ToolCall } from "../providers/tool-wire.js";

/** Asking for a change that deletes or reshapes: the verbs, and the shapes a
 *  new list is asked for in. */
const CHANGE =
  /\b(?:delete|remove|erase|trash|get rid of|throw (?:it |them )?(?:away|out)|wipe|uninstall|turn (?:it |them )?off|switch (?:it |them )?off|disable|as a whole|(?:create|make|start|add) (?:a |an )?(?:new )?(?:list|collection|section|table|field)|file (?:these|them|this|it|all)(?: \d+)? (?:in|into|under))\b/i;

/** A question about the workspace, not a request: "which ones did I delete
 *  last week?", "how do I remove a field?". A request phrased politely as a
 *  question ("can you delete this?") is still a request. */
const QUESTION = /^\s*(?:how|what|which|where|when|why|who|is|are|was|were|did|does|do(?!n't))\b/i;
const REQUEST = /\b(?:can you|could you|would you|will you|please|i want|i'd like|i would like|let's|go ahead)\b/i;

export function asksForAChange(message: string): boolean {
  if (!CHANGE.test(message)) return false;
  return !QUESTION.test(message) || REQUEST.test(message);
}

/** Whether a round's calls are a change the fuller model should plan: a
 *  delete, a filing into a list, or an action that reshapes the workspace or
 *  cannot be undone (asked of the registry, so a new action is judged by what
 *  it declares, not by a list kept here). */
export async function proposesSeriousChange(
  calls: readonly ToolCall[] | undefined,
  actionIsSerious: (actionId: string) => Promise<boolean>,
): Promise<boolean> {
  for (const call of calls ?? []) {
    if (call.name === "delete_record" || call.name === "file_inbox_items") return true;
    if (call.name === "invoke_action") {
      const id = (call.args as { action_id?: unknown } | undefined)?.action_id;
      if (typeof id === "string" && (await actionIsSerious(id))) return true;
    }
  }
  return false;
}
