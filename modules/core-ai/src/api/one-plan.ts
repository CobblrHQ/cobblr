// One request, one plan, one Confirm.
//
// "Delete this and yarn as a whole", with a yarn record in context, drew two
// cards: the delete, and "Remove Yarn, keeping its records · Yarn stays, with
// its 1 record". The person asked for one thing; they got two Confirms, the
// second kept the records they asked to remove and counted the record the
// first deletes, and the card from their previous message stayed live beside
// them (2026-10-02). So the changes one message asks for are one card: its
// steps in the order they run, each worded after the steps before it, each
// saying whether it can be undone, as its action declares, and one Confirm
// that runs them in order. A card an earlier message left for the same
// things is replaced by it.
//
// These are the parts with no workspace in them; chat.ts plans the steps.

export interface Card {
  summary: string;
  proposal: Record<string, unknown>;
  offer_id?: string;
}

/** "As a whole", "and everything in it": the records go too. */
export const WHOLE = /\b(?:as a whole|altogether|entirely|completely|and everything in it|and (?:all )?its records|records and all)\b/i;

export function cardsOf(result: Record<string, unknown>): Card[] {
  if (result.type === "proposal" && result.proposal) {
    return [{ summary: String(result.summary ?? ""), proposal: result.proposal as Record<string, unknown>, ...(typeof result.offer_id === "string" ? { offer_id: result.offer_id } : {}) }];
  }
  return result.type === "proposals" && Array.isArray(result.items) ? (result.items as Card[]) : [];
}

/** The result carrying these cards instead of the ones it had. */
export function withCards(result: Record<string, unknown>, cards: Card[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  delete out.proposal;
  delete out.summary;
  delete out.items;
  delete out.offer_id;
  if (cards.length === 1) {
    out.type = "proposal";
    out.summary = cards[0]!.summary;
    out.proposal = cards[0]!.proposal;
  } else {
    out.type = "proposals";
    out.items = cards;
  }
  return out;
}

/** "Delete “Charisma” (permanent), then remove Yarn (permanent)". A later
 *  step's verb loses its capital; a name keeps its. */
export function planTitle(summaries: readonly string[]): string {
  return summaries
    .map((s, i) => (i > 0 && /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s))
    .join(", then ");
}

const lowered = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** What a card would change, as keys two cards can share: the record it
 *  writes, or the feature, bundle or field an action names. A card that
 *  shares one with a newer card for the same person is replaced by it. */
export function targetsOf(proposal: unknown): string[] {
  if (!proposal || typeof proposal !== "object") return [];
  const p = proposal as Record<string, unknown>;
  if (p.kind === "plan" && Array.isArray(p.steps)) {
    return [...new Set((p.steps as Array<{ proposal?: unknown }>).flatMap((s) => targetsOf(s.proposal)))];
  }
  if ((p.kind === "update" || p.kind === "delete") && typeof p.entity_id === "string") return [`record:${p.entity_id}`];
  if (p.kind === "action") {
    const args = (p.args && typeof p.args === "object" ? p.args : {}) as Record<string, unknown>;
    const out: string[] = [];
    if (typeof p.entity_id === "string" && p.entity_id) out.push(`record:${p.entity_id}`);
    // A bundle and a feature are named the same way by a person ("Yarn"),
    // and "turn Yarn off" and "remove Yarn" are offers about one thing.
    for (const key of ["bundle", "module"]) if (lowered(args[key])) out.push(`thing:${lowered(args[key])}`);
    if (lowered(args.field)) out.push(`field:${lowered(args.entity_kind)}:${lowered(args.field)}`);
    return out;
  }
  return [];
}

/** Whether two cards are about the same thing. */
export function overlaps(a: unknown, b: unknown): boolean {
  const mine = new Set(targetsOf(a));
  return mine.size > 0 && targetsOf(b).some((t) => mine.has(t));
}
