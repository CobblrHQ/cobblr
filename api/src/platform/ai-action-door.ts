// Whether an action may run for a caller that has no way to show a person a
// confirmation: an assistant over MCP (the stdio server, the hosted endpoint
// with any token, a connector signed in with OAuth) or the in-app chat's
// relay grant.
//
// The rule used to live only in the relay's tool call, so every other MCP
// door posted straight to /actions/invoke and a connector allowed to "change"
// could run an action that needs a person (start a machine) with nobody
// asked. It is asked at the route now, where every door arrives, and the
// hosted endpoint reads the same answer to refuse early in the same words.

import { actionRunsUnconfirmed, effectNeedsAPerson } from "@cobblr/platform-contract/action-consent";
import { meta } from "../db/meta.js";
import { productName } from "./product-name.js";
import { hasUndo } from "./actions.js";

export interface ActionSafety {
  id: string;
  label: string | null;
  undoable: boolean;
  /** The declared effect (none, writes, physical, spends), or null. */
  effect: string | null;
  /** It has an Undo in the app, though it is not one an AI may run
   *  unconfirmed (a tag merge reaches every record carrying the tag). */
  undoInApp: boolean;
}

/** How a refusal names what an action does. A label, not a decision. */
const EFFECT_WORDS: Record<string, string> = { physical: "starts or moves a machine", spends: "spends money" };

/** What the registry says about an action's safety. Read straight from
 *  cobblr_meta rather than over REST: the decision must not depend on the
 *  caller's own token, and registry-sync keeps the row current from the
 *  manifest on every boot. */
export async function actionSafety(actionId: string): Promise<ActionSafety | null> {
  if (!actionId) return null;
  const row = await meta
    .selectFrom("entity_actions")
    .select(["id", "label", "undoable", "effect", "invoke_handler"])
    .where("id", "=", actionId)
    .executeTakeFirst();
  return row
    ? { id: row.id, label: row.label, undoable: row.undoable === true, effect: row.effect, undoInApp: !!row.invoke_handler && hasUndo(row.invoke_handler) }
    : null;
}

/** Why this caller may not run this PARTICULAR action, or null if they may.
 *
 *  An action that cannot be put right again needs a person in front of it, and
 *  this connection cannot show one a confirmation. Actions declare that for
 *  themselves (`undoable` in the manifest), defaulting to false, so a new
 *  action is cautious until someone decides otherwise. */
export function actionRefusal(action: { id: string; label?: string | null; undoable?: boolean; effect?: string | null; undoInApp?: boolean } | null): string | null {
  if (!action) return null; // unknown id — let the invoke route give its own error
  // The one rule every door reads; the in-app auto chat asks the same question.
  if (actionRunsUnconfirmed(action)) return null;
  const name = action.label ? `"${action.label}"` : action.id;
  if (effectNeedsAPerson(action.effect)) {
    const what = EFFECT_WORDS[action.effect ?? ""] ?? "acts outside the workspace";
    return `${name} ${what}, so a person always confirms it, and this connection has no way to show a confirmation. Run it from ${productName()}, where the confirm step appears.`;
  }
  // Saying "cannot be undone" of an action with an Undo one tap away in the
  // app is false, and it was what an assistant told its person (#7825).
  if (action.undoInApp) {
    return `${name} changes enough at once that a person confirms it before it runs (its Undo is in ${productName()} afterwards), and this connection has no way to show a confirmation. Run it from ${productName()}, where the confirm step appears.`;
  }
  return `${name} cannot be undone from inside the workspace, so it needs a person to confirm it, and this connection has no way to show a confirmation. Run it from ${productName()}, where the confirm step appears. Actions that CAN be undone run from here normally - list_actions marks each one.`;
}
