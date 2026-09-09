// What a scan-time re-purchase means for the consumption ledger.
//
// Kept pure and separate from the attach route because the interesting part is
// the DECISION, not the HTTP. Getting it wrong is quiet and expensive: record
// waste as consumption and the learned rate climbs, so the system recommends
// buying more of the thing you keep throwing away. That inversion is the whole
// reason consume and discard are different event types.

export type CadenceContext = "normal" | "faster" | "bulk" | "one_off";
export type CadenceResolution = "over_buy" | "consumed" | "discarded";

export interface CadenceEventBody {
  entity_kind: string;
  entity_id: string;
  event_type: "purchase" | "consume" | "discard";
  qty_delta: number;
  context?: CadenceContext;
  source: "scan";
}

export interface BuildOpts {
  mode: string;
  cadence?: { context?: CadenceContext; resolution?: CadenceResolution } | undefined;
  kind: string;
  entityId: string;
  /** How many units this scan added. */
  added: number;
  /** What was on the shelf BEFORE the bump, per the entity itself. */
  priorQty: number;
}

/**
 * The ledger events an attach should file, in order.
 *
 * `add-qty` ("+N, more of the same") and `replace` ("the one I had ran out,
 * this is the new one") are purchases. `link-barcode`, `move` and
 * `merge-fields` teach or relocate an entity and consume nothing, so they file
 * nothing; treating them as purchases would invent a shopping habit out of a
 * barcode being linked.
 */
export function buildCadenceEvents(opts: BuildOpts): CadenceEventBody[] {
  const replace = opts.mode === "replace";
  if (opts.mode !== "add-qty" && !replace) return [];
  if (!(opts.added > 0)) return [];

  const base = { entity_kind: opts.kind, entity_id: opts.entityId, source: "scan" as const };
  const events: CadenceEventBody[] = [
    {
      ...base,
      event_type: "purchase",
      qty_delta: opts.added,
      ...(opts.cadence?.context ? { context: opts.cadence.context } : {}),
    },
  ];

  // What happened to the stock that was still there. Only a human knows, so
  // with no answer we record only the purchase rather than inventing one.
  // `replace` IS the answer: the one you had ran out, which is consumption
  // unless the person said it went bad. That is the everyday re-buy, and the
  // fact the ledger measures its interval from.
  const resolution = opts.cadence?.resolution ?? (replace ? "consumed" : undefined);
  if (!resolution || resolution === "over_buy") return events;
  if (!(opts.priorQty > 0)) return events; // nothing was left to explain

  events.push({
    ...base,
    event_type: resolution === "consumed" ? "consume" : "discard",
    qty_delta: -opts.priorQty,
  });
  return events;
}
