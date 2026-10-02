// A card on the conversation is an offer the server keeps (core_ai_offers):
// what the card shows, and whether it can still be confirmed, come from that
// record. After a reload, in another tab or on another device, the panel
// reads its offers back and redraws each card as it now stands: a live card
// with its details and Confirm when nobody has answered it, and what became
// of it ("Confirmed: Deleted …", "Cancelled", "Replaced by the plan below")
// when somebody has. Before this, a reload showed the plans' titles as plain
// text with no card and no Confirm (2026-10-02).

import type { AiChatOfferState, AiChatProposal } from "./api";

export type OfferStatus = AiChatOfferState["status"];

/** What became of an answered offer, as the card says it. */
export interface OfferOutcome {
  status: Exclude<OfferStatus, "open">;
  message?: string;
}

interface OfferMessage {
  offerId?: string;
  proposal?: AiChatProposal;
  resolved?: boolean;
  content: string;
  offerState?: OfferOutcome;
}

/** The offers a conversation names that may still change: every offer not
 *  known to be finished. */
export function offerIdsToRefresh(messages: readonly OfferMessage[]): string[] {
  const done = new Set<OfferStatus>(["confirmed", "failed", "cancelled", "replaced"]);
  return [...new Set(messages.filter((m) => m.offerId && !(m.offerState && done.has(m.offerState.status))).map((m) => m.offerId!))].slice(-200);
}

/** The conversation with each card redrawn from its kept offer. Returns the
 *  same array when nothing changed, so a caller can skip a render. */
export function applyOfferStates<M extends OfferMessage>(messages: M[], states: readonly AiChatOfferState[]): M[] {
  const byId = new Map(states.map((s) => [s.id, s]));
  let changed = false;
  const out = messages.map((m) => {
    const s = m.offerId ? byId.get(m.offerId) : undefined;
    if (!s) return m;
    const next: M = { ...m, proposal: s.proposal, content: m.content || s.summary };
    if (s.status === "open") {
      next.resolved = false;
      delete next.offerState;
    } else {
      next.resolved = true;
      next.offerState = { status: s.status, ...(s.outcome?.message ? { message: s.outcome.message } : {}) };
    }
    if (JSON.stringify(next) !== JSON.stringify(m)) changed = true;
    return next;
  });
  return changed ? out : messages;
}

const bare = (s: string) => s.replace(/^[✓✗]\s*/, "").trim();

/** The line an answered card shows under its title. `later` is what the
 *  conversation says after the card: when it already says what happened (the
 *  done message Confirm adds, which carries the Undo), the card says only
 *  that it was confirmed, so the sentence is read once. */
export function offerOutcomeWords(o: OfferOutcome, later: readonly string[] = []): string {
  const said = o.message ? bare(o.message) : "";
  const saidBelow = !!said && later.some((c) => bare(c) === said);
  switch (o.status) {
    case "confirmed":
      return said && !saidBelow ? `Confirmed: ${said}` : "Confirmed";
    case "confirming":
      return "Being done now";
    case "failed":
      return said ? `Didn't go through: ${said}` : "Didn't go through";
    case "cancelled":
      return "Cancelled";
    case "replaced":
      return "Replaced by the plan below";
  }
}
