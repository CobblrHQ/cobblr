// What the panel shows after a turn has already changed things, and how it is
// taken back.
//
// ONE instruction, ONE way to undo it. Several changes used to arrive as
// several cards, each with its own small Undo, which hands the work of
// reversing one instruction back to the person: press this, then that, and
// hope you got them all and in an order that works.
//
// It hurts most when the turn did the WRONG thing, which is exactly when undo
// matters. Asked to move the tea on a page into the Tea section, Cobb created
// two new records instead of moving the five that were there - and offered two
// separate Undo buttons for what was one mistake (2026-09-08).
//
// So a turn that changed more than one thing is one card that says what
// happened and carries a single "Undo all N". That is what the relay path has
// always done for a bulk write, and what the server has always supported:
// POST /chat/undo-turn puts a whole instruction back, newest-first (a shelf
// before the rack it is in), and reports what it held rather than forcing it.
//
// The detail stays on the card. A bare count ("Made 2 changes") tells you
// something happened and not what, which is the one report you cannot check.

import { refsOfResponse, type ChatEntityRef } from "./entity-chips";

/** One applied write, as the chat response reports it. */
export interface AppliedWrite {
  summary: string;
  ledger_id?: string;
  undoable?: boolean;
  entity?: { kind: string; id?: string; label?: string };
  touched?: ChatEntityRef[];
}

/** A "done" card for the panel. A subset of the panel's message shape. */
export interface AppliedCard {
  role: "assistant";
  content: string;
  resolved: true;
  /** The records the card names, so each name renders as a chip. */
  refs?: ChatEntityRef[];
  ledgerId?: string;
  ledgerIds?: string[];
  undoTurnId?: string;
  undoable?: boolean;
}

export function appliedCards(applied: AppliedWrite[], turnId: string | null): AppliedCard[] {
  if (applied.length === 0) return [];
  const refs = refsOfResponse({ applied });
  if (applied.length === 1) {
    const only = applied[0]!;
    return [
      {
        role: "assistant",
        content: only.summary,
        resolved: true,
        ...(refs.length ? { refs } : {}),
        ...(only.ledger_id ? { ledgerId: only.ledger_id } : {}),
        ...(only.undoable === undefined ? {} : { undoable: only.undoable }),
      },
    ];
  }
  const ids = applied.map((a) => a.ledger_id).filter((x): x is string => !!x);
  return [
    {
      role: "assistant",
      content: [
        `Made ${applied.length} changes:`,
        "",
        ...applied.map((a) => `- ${a.summary.replace(/\.$/, "")}`),
      ].join("\n"),
      resolved: true,
      ...(refs.length ? { refs } : {}),
      ...(ids.length ? { ledgerIds: ids } : {}),
      // Naming the turn is what lets ONE request put them all back. Without it
      // the handler falls through to pressing the handles this card holds,
      // which still works: an older message, or a turn whose id never arrived,
      // keeps its undo.
      ...(turnId ? { undoTurnId: turnId } : {}),
      // Undoable if ANY of them is. A card that says nothing can be put back
      // because one row is a container with things in it would be wrong about
      // the other three, and the server reports what it held either way.
      undoable: applied.some((a) => a.undoable),
    },
  ];
}
