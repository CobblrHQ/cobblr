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
// pinned by name (api/tests/undoable-actions-pinned.test.ts), and a guard
// holds that every flagged action has registered how it is undone. Default
// false: a new action is cautious until someone decides otherwise. An action
// that registers an inverse and still says false (the move between lists)
// is asking for its confirm card on purpose, and gets it on both doors.

export interface ActionConsent {
  /** The action, so a caller can say which one it asked about. */
  id?: string;
  undoable?: boolean | null;
}

export function actionRunsUnconfirmed(action: ActionConsent | null | undefined): boolean {
  return action?.undoable === true;
}
