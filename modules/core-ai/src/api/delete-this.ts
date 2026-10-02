// "Delete this" is a card, whatever the model did with the rest.
//
// A person with a yarn record in the chat's context ("About: Loops & Threads
// Charisma Yarn") wrote "delete this and yarn as a whole". The model proposed
// one change, turning the Yarn feature off, and the card read back only that:
// the record they asked to delete was never offered. The readback says
// "delete this item" and then the rest, as the steps of one plan with one
// Confirm (one-plan.ts, 2026-10-02).
//
// The model chooses the changes; this makes sure the one that is unmistakable
// is there. A message that says delete or remove "this" (or "it", "this one")
// with exactly one record in context means that record, so the delete card is
// added from code when the model's cards do not already delete it. It is a
// card, never a deletion: the person still confirms it. And it reads only
// what the person pointed at, so it can never offer to delete anything else.

type Item = { summary: string; proposal: Record<string, unknown> };

/** The record the next message is about: the chip above the box. */
export interface PointedAt {
  label: string;
  kind?: string;
  ids?: string[];
}

/** Delete, remove or trash "this" (or "it", "this one"), as a whole clause:
 *  followed by an end, a comma or an "and", so "delete this tag" or "remove
 *  it from the list" is never read as deleting the record. */
const DELETE_THIS = /\b(?:delete|remove|trash|get rid of|throw (?:away|out))\s+(?:this|it|this one|that one)(?:\s+(?:one|item|record|thing))?(?=\s*(?:$|[,.!;]|\band\b|\bplease\b|\btoo\b|\bas well\b|\baltogether\b|\bentirely\b))/i;

export function asksToDeleteThis(message: string): boolean {
  return DELETE_THIS.test(message);
}

function cardsOf(out: Record<string, unknown>): Item[] {
  if (out.type === "proposal" && out.proposal) return [{ summary: String(out.summary ?? ""), proposal: out.proposal as Record<string, unknown> }];
  return Array.isArray(out.items) ? (out.items as Item[]) : [];
}

/** The reply with a delete card for the record in context, first (it was
 *  asked for first, and it is the irreversible one), when the message asks
 *  to delete it and no card already does. */
export function withDeleteThisCard(result: Record<string, unknown>, message: string, pointed: PointedAt | null | undefined): Record<string, unknown> {
  const id = pointed?.ids?.length === 1 ? pointed.ids[0] : undefined;
  const kind = pointed?.kind;
  if (!id || !kind || !asksToDeleteThis(message)) return result;
  const cards = cardsOf(result);
  if (cards.some((c) => c.proposal.kind === "delete" && c.proposal.entity_id === id)) return result;
  const card: Item = {
    summary: `Delete “${pointed!.label}” (permanent)`,
    proposal: { kind: "delete", entity_kind: kind, entity_id: id, entity_label: pointed!.label },
  };
  const out: Record<string, unknown> = { ...result };
  const all = [card, ...cards];
  delete out.proposal;
  delete out.summary;
  if (all.length === 1) {
    out.type = "proposal";
    out.summary = card.summary;
    out.proposal = card.proposal;
  } else {
    out.type = "proposals";
    out.items = all;
  }
  return out;
}
