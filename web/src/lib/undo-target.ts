// What "undo that" points at in a Cobb conversation (#8738).
//
// "Delete the cordless drill" got a card; the person, thinking better of it,
// said "undo that". Nothing had been done, but the panel looked back for the
// newest change it could undo, walked past the open card, and undid
// "Created drill bits" from three messages earlier, saying only "Undone."
// "That" is the newest thing on screen: an open card is answered by dropping
// it, and only a change already made is undone, by its name.
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
}

export type UndoTarget =
  | { kind: "card"; index: number }
  | { kind: "change"; index: number; handles: string[]; said: string };

const openCard = (m: UndoableMessage) => m.role === "assistant" && !!(m.proposal || m.offerId) && !m.resolved && !m.offerState;

/** The newest open card or undoable change, whichever comes last. */
export function undoTarget(messages: readonly UndoableMessage[]): UndoTarget | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (openCard(m)) return { kind: "card", index: i };
    if (m.undone) continue;
    const handles = m.ledgerIds ?? (m.ledgerId ? [m.ledgerId] : []);
    if (handles.length) return { kind: "change", index: i, handles, said: m.content.replace(/^[✓✗]\s*/, "").trim() };
  }
  return null;
}

/** The answer once a change is undone: what it was, never just "Undone." */
export function undoneSaid(said: string, ok: number, of: number): string {
  const what = said ? `: ${said.replace(/\.$/, "")}` : "";
  if (ok === of) return `✓ Undone${what}.`;
  return ok ? `✓ Undid ${ok} of ${of}${what}.` : "✗ I couldn't undo that.";
}

/** What the panel asks the no-AI rules with, to learn whether a message is an
 *  undo of the target: a change's own handles, or for an open card a handle
 *  no change has, since nothing of the card's was done. */
export function undoAsk(target: UndoTarget): BasicPrior {
  return { ledger_ids: target.kind === "change" ? target.handles : [NOTHING_DONE_YET] };
}
