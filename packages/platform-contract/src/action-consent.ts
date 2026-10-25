// Whether an action may run with no person confirming it.
//
// Two doors run an action for an AI: a relayed chat that has no way to show a
// confirmation card, and the in-app chat with Changes set to auto. Both used
// to decide this for themselves, and for a month they decided differently:
// the relay read the action's declared `undoable` flag, the in-app chat held
// every action regardless. One rule, here, that both import.
//
// The flag means exactly this. `undoable: true` on a declaration is a safety
// decision, not a detail: the action's every effect stays inside the
// workspace, and a person can put it back without help, so an AI may run it
// and the person reads what happened on a card with an Undo. The set is
// pinned by name (scripts/lib/undoable-actions-pinned.test.ts), and a guard
// holds that every flagged action has registered how it is undone. Default
// false: a new action is cautious until someone decides otherwise. An action
// that registers an inverse and still says false (the move between lists)
// is asking for its confirm card on purpose, and gets it on both doors.
//
// The declared effect sits above the flag. Whether an effect needs a person
// is the Services rule (service-consent), asked here as the most permissive
// AI door would ask it: an AI in Changes: auto. What that door would still
// hold (physical, spends, and any effect it does not know, read as physical)
// is held on every AI door, whatever `undoable` says: putting a record back
// does not un-start a machine.
//
// An action that declares `effect: "none"` reads and writes nothing, so there
// is nothing to confirm and nothing to put back: it runs on every AI door, as
// a Services capability declaring "none" already did. Reads declared nothing
// and were refused over MCP as "cannot be undone" (a barcode lookup #7858, a
// board's stock check #7885). The set is pinned by name beside the undoable
// one, so "none" is a decision someone reviewed.

import { serviceWaitsForAPerson } from "@cobblr/platform-contract/service-consent";

/** Whether a declared effect always needs a person's yes: the Services
 *  answer for an AI on Changes: auto, asked of the one function that gives
 *  it, so an action and a service job cannot come to disagree. An action
 *  that declares no effect falls to its `undoable` flag instead. */
export function effectNeedsAPerson(effect: string | null | undefined): boolean {
  return effect != null && serviceWaitsForAPerson(effect);
}

export interface ActionConsent {
  /** The action, so a caller can say which one it asked about. */
  id?: string;
  undoable?: boolean | null;
  /** The declared effect (`exposes.actions[].effect`). */
  effect?: string | null;
}

export function actionRunsUnconfirmed(action: ActionConsent | null | undefined): boolean {
  if (effectNeedsAPerson(action?.effect)) return false;
  if (action?.effect === "none" || action?.effect === "signal" || action?.effect === "stops") return true;
  return action?.undoable === true;
}
