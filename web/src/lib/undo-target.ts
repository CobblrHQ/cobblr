// What "undo that" points at in a Cobb conversation (#8738).
//
// "Delete the cordless drill" got a card; the person, thinking better of it,
// said "undo that". Nothing had been done, but the panel looked back for the
// newest change it could undo, walked past the open card, and undid
// "Created drill bits" from three messages earlier, saying only "Undone."
// "That" is the newest thing on screen: an open card is answered by dropping
// it, and only a change already made is undone, by its name.
//
// A turn that failed is the newest thing too (#9509). Two moves the provider
// refused ("Nothing was changed"), then "undo that": the panel walked past
// both and deleted the black PLA made two turns before. The person meant the
// move, which never happened, so the answer is that there is nothing to undo.
//
// And so is a request that changed nothing (#9579). "Move the drill to Shelf
// B." answered "I couldn't find a drill", then "undo that": the panel walked
// back and deleted the Garage made three turns before. A request (not a
// question) whose answer made no change is the newest thing, and "that" is it.
import { NOTHING_DONE_YET, type BasicPrior } from "@cobblr/platform-contract/basics-limits";

export interface UndoableMessage {
  role: "user" | "assistant";
  content: string;
  proposal?: unknown;
  offerId?: string;
  resolved?: boolean;
  offerState?: unknown;
  ledgerId?: string;
  ledgerIds?: string[];
  undone?: boolean;
  /** The turn failed, and this message says why. */
  failed?: boolean;
}

export type UndoTarget =
  | { kind: "card"; index: number }
  | { kind: "change"; index: number; handles: string[]; said: string }
  | { kind: "failed"; index: number }
  | { kind: "unchanged"; index: number };

const openCard = (m: UndoableMessage) => m.role === "assistant" && !!(m.proposal || m.offerId) && !m.resolved && !m.offerState;

// ascii-only: an English question mark and English undo words; another language's request is walked past as before #9579
const ASKED = /\?\s*$/;
// ascii-only: as above
const UNDO_WORDS = /^\s*(undo|put (it|that) back|take (it|that) back|revert)\b/i;

/** The newest open card, failed turn, request that changed nothing, or
 *  undoable change, whichever comes last. */
export function undoTarget(messages: readonly UndoableMessage[]): UndoTarget | null {
  let answered = false;
  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      // A request answered with no change at all: "that" is this request.
      if (answered && !changed && !ASKED.test(m.content) && !UNDO_WORDS.test(m.content)) return { kind: "unchanged", index: i };
      answered = false;
      changed = false;
      continue;
    }
    answered = true;
    if (openCard(m)) return { kind: "card", index: i };
    if (m.failed) return { kind: "failed", index: i };
    const handles = m.ledgerIds ?? (m.ledgerId ? [m.ledgerId] : []);
    if (handles.length) changed = true;
    if (m.undone) continue;
    if (handles.length) return { kind: "change", index: i, handles, said: m.content.replace(/^[✓✗]\s*/, "").trim() };
  }
  return null;
}

/** The answer once a change is undone: what it was, never just "Undone." */
/** A reply that names nothing ("Done.", "OK"): "✓ Undone: Done." said
 *  nothing about what was taken back (#9518). */
const SAYS_NOTHING = /^(?:done|ok(?:ay)?|saved|applied|finished|all set|all done|got it|sure|yes)[.!]?$/i;

export function undoneSaid(said: string, ok: number, of: number, undoSaid: readonly string[] = []): string {
  const named = said && !SAYS_NOTHING.test(said.trim()) ? said : (undoSaid.find((s) => s.trim() && !SAYS_NOTHING.test(s.trim())) ?? "");
  if (named !== said && named) return ok === of ? `✓ ${named.trim().replace(/\.$/, "")}.` : ok ? `✓ Undid ${ok} of ${of}: ${named.trim().replace(/\.$/, "")}.` : "✗ I couldn't undo that.";
  const what = named ? `: ${named.replace(/\.$/, "")}` : "";
  if (ok === of) return `✓ Undone${what}.`;
  return ok ? `✓ Undid ${ok} of ${of}${what}.` : "✗ I couldn't undo that.";
}

/** The answer to "undo that" when the newest thing is a turn that failed. */
export const AFTER_A_FAILED_TURN = "Nothing to undo: that last request did not go through, so nothing was changed. What was done before it is still there, each with its own ↩ Undo.";

/** The answer to "undo that" when the newest thing is a request that changed nothing. */
export const AFTER_NOTHING_CHANGED = "Nothing to undo: that last request changed nothing. What was done before it is still there, each with its own ↩ Undo.";

/** What the panel asks the no-AI rules with, to learn whether a message is an
 *  undo of the target: a change's own handles, or for an open card a handle
 *  no change has, since nothing of the card's was done. */
export function undoAsk(target: UndoTarget): BasicPrior {
  return { ledger_ids: target.kind === "change" ? target.handles : [NOTHING_DONE_YET] };
}
