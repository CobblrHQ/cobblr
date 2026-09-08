// What a one-tap mark on an item MEANS for whoever keeps a consumption ledger.
//
// The taps (Use one, Used up, Finished it, Threw it out, Restock one) changed
// the count and taught shelf life, and told the cadence ledger nothing: it
// learned purchases from a scan commit or a shopping-list tick, and nothing
// else. So a person who ran out of tea and bought an identical box, marking
// the old one finished and the new one restocked, had the right count and a
// dated lot, and the interval was never learned (2026-09-08).
//
// Inventory announces the meaning here, in the ledger's own vocabulary
// (purchase / consume / discard), on `inventory.stock.observed` - the same
// shape core-scan announces a scan commit with, so one subscriber serves
// both. It does not know or care who listens. Pure; the emit is beside the
// handlers.

export type ObservedEvent = "purchase" | "consume" | "discard";

export interface StockObservation {
  entity_kind: "inventory:part";
  entity_id: string;
  event_type: ObservedEvent;
  qty_delta: number;
  source: "manual";
}

export function observation(partId: string, event: ObservedEvent, qtyDelta: number): StockObservation {
  return { entity_kind: "inventory:part", entity_id: partId, event_type: event, qty_delta: qtyDelta, source: "manual" };
}

/** Replaced with a fresh one: the old one is finished and a new one arrived,
 *  in one tap. The count does not move, and the ledger hears exactly what
 *  happened: one consumed, one bought. Two facts, because that is two facts;
 *  the interval between purchases is what the ledger measures. */
export function swapFreshObservations(partId: string): StockObservation[] {
  return [observation(partId, "consume", -1), observation(partId, "purchase", 1)];
}
