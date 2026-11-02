// An undo-only action pressed without its issued Undo (#4115).

/** An action that is only another's way back (`internal` in its manifest)
 *  acts on the ids and values its arguments name: what that run made, as it
 *  answered them. Pressed without the undo the platform issued for that run,
 *  those arguments are whatever the caller wrote, and the action is only as
 *  safe as its handler's own checks; a floor-plan import's Undo handed a room
 *  it never made deleted the room past the admin gate (#4115, #9116).
 *
 *  Refused since the release after the one that only logged it (#9118,
 *  #9117): every client in that release sent the undo_id it was handed, so
 *  an app still sending none had rolled off. Turn it back to false only to
 *  log again while a client is fixed. */
export const UNDO_ONLY_NEEDS_ITS_UNDO = true;

/** What the door does with a press: an undo-only action pressed without its
 *  issued Undo is logged while UNDO_ONLY_NEEDS_ITS_UNDO is off, refused once
 *  it is on; anything else runs on to the other gates. */
export function undoOnlyVerdict(p: { undoOnly: boolean; ownUndo: boolean; enforce: boolean }): "run" | "log" | "refuse" {
  if (!p.undoOnly || p.ownUndo) return "run";
  return p.enforce ? "refuse" : "log";
}
