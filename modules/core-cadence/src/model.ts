// The cadence engine — pure functions, no DB, no platform. Everything the
// capability decides lives here so it is unit-testable and so the storage layer
// stays a thin adapter.
//
// Design decisions encoded here (docs/design-decisions/consumption-cadence.md):
//
//  • CONSUME ≠ DISCARD. Only consumption raises the rate. Recording waste as
//    consumption would inflate the rate and tell you to buy MORE of the thing you
//    keep throwing away — the exact opposite of "we bought this but didn't need
//    it". Discards feed the waste loop instead.
//  • Purchase CONTEXT guards the rate. One Costco run must not teach "48 rolls a
//    week", so a purchase tagged one_off/bulk is damped out of the interval
//    series and `faster` is allowed to pull the rate up.
//  • COLD-START HONESTY. Below the confidence threshold there is no run-out date,
//    only "learning". A fabricated date is worse than none.
//  • ONE reorder signal. `min_qty` (static floor, works from day one) and the
//    learned rate (needs history) unify into a single boolean rather than two
//    competing mechanisms — the Household Supplies bundle already ships the
//    threshold half.

/** A quantity change. `qty_delta` is signed and in the item's stored unit. */
export interface CadenceEvent {
  event_type: "purchase" | "consume" | "adjust" | "discard";
  qty_delta: number;
  /** Purchase weighting. Absent = `normal`. */
  context?: "normal" | "one_off" | "bulk" | "faster";
  /** When it happened (receipt date), not when it was ingested. */
  occurred_at: Date;
}

export interface CadenceState {
  /** Units currently believed on hand. */
  on_hand_estimate: number;
  /** Units consumed per day. null while still learning. */
  cadence_rate: number | null;
  /** Days until on_hand hits zero at the current rate. null while learning. */
  days_until_runout: number | null;
  /** discarded / (consumed + discarded) over the window. 0 when nothing left. */
  waste_ratio: number;
  /** Enough history to trust the rate? */
  confidence: "learning" | "low" | "good";
}

/** How much of a purchase counts toward the learned rate. */
const CONTEXT_WEIGHT: Record<string, number> = {
  normal: 1,
  faster: 1,
  bulk: 0.25, // stocking up: some of it is genuinely consumption, most is shelf
  one_off: 0, // a party — not your cadence at all
};

/** Recency weighting: the most recent interval counts most. */
const EWMA_ALPHA = 0.5;
const MS_PER_DAY = 86_400_000;

/** Purchases that actually inform the rate, oldest first. */
function ratePurchases(events: CadenceEvent[]): CadenceEvent[] {
  return events
    .filter((e) => e.event_type === "purchase" && (CONTEXT_WEIGHT[e.context ?? "normal"] ?? 1) > 0)
    .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
}

/**
 * Units/day, learned from how fast repeat purchases recur.
 *
 * A re-purchase is the zero-effort signal that the previous lot is gone, so
 * `qty ÷ days-since-the-last-one` is a consumption rate without anyone logging a
 * thing. EWMA over those intervals so a changed habit shows up quickly.
 * Returns null when there is not enough history to say (cold-start honesty).
 */
export function cadenceRate(events: CadenceEvent[]): number | null {
  const purchases = ratePurchases(events);
  if (purchases.length < 2) return null; // one purchase is not an interval

  let ewma: number | null = null;
  for (let i = 1; i < purchases.length; i++) {
    const prev = purchases[i - 1]!;
    const cur = purchases[i]!;
    const days = (cur.occurred_at.getTime() - prev.occurred_at.getTime()) / MS_PER_DAY;
    if (days <= 0) continue; // same-day top-up: no interval to learn from
    // The PREVIOUS lot is what got consumed over this interval.
    const weight = CONTEXT_WEIGHT[prev.context ?? "normal"] ?? 1;
    const rate = (Math.abs(prev.qty_delta) * weight) / days;
    ewma = ewma === null ? rate : EWMA_ALPHA * rate + (1 - EWMA_ALPHA) * ewma;
  }
  return ewma !== null && ewma > 0 ? ewma : null;
}

/** Running quantity from the ledger. */
export function onHandEstimate(events: CadenceEvent[]): number {
  return Math.max(0, events.reduce((sum, e) => sum + e.qty_delta, 0));
}

/**
 * Waste ratio: discarded ÷ (consumed + discarded).
 *
 * The second half of "we bought this but we didn't need it" — a high ratio means
 * the answer is buy LESS, not reorder sooner.
 */
export function wasteRatio(events: CadenceEvent[]): number {
  let consumed = 0;
  let discarded = 0;
  for (const e of events) {
    if (e.event_type === "consume") consumed += Math.abs(e.qty_delta);
    else if (e.event_type === "discard") discarded += Math.abs(e.qty_delta);
  }
  const total = consumed + discarded;
  return total === 0 ? 0 : discarded / total;
}

function confidenceOf(events: CadenceEvent[]): CadenceState["confidence"] {
  const n = ratePurchases(events).length;
  if (n < 2) return "learning";
  return n < 4 ? "low" : "good";
}

/** Everything derivable from one item's ledger. */
export function cadenceState(events: CadenceEvent[]): CadenceState {
  const rate = cadenceRate(events);
  const onHand = onHandEstimate(events);
  const confidence = confidenceOf(events);
  // No rate (or no stock) means no honest run-out date.
  const runout = rate !== null && rate > 0 && confidence !== "learning" ? onHand / rate : null;
  return {
    on_hand_estimate: onHand,
    cadence_rate: confidence === "learning" ? null : rate,
    days_until_runout: runout,
    waste_ratio: wasteRatio(events),
    confidence,
  };
}

/**
 * ONE reorder signal, not two.
 *
 * `min_qty` is the static floor a user can set on day one; the learned rate takes
 * over as history accrues. Either firing is enough, so a workspace that only ever
 * sets `min_qty` keeps exactly its current behaviour.
 */
export function reorderSuggested(
  state: CadenceState,
  opts: { minQty?: number | null; leadTimeDays?: number } = {},
): boolean {
  const { minQty, leadTimeDays = 2 } = opts;
  if (minQty != null && state.on_hand_estimate <= minQty) return true;
  return state.days_until_runout != null && state.days_until_runout <= leadTimeDays;
}

/** Buy LESS: enough of this keeps going bad that reordering is the wrong advice. */
export function buyLessSuggested(state: CadenceState, threshold = 1 / 3): boolean {
  return state.waste_ratio >= threshold && state.confidence !== "learning";
}

/**
 * What a NEW purchase means when stock should still remain.
 *
 * This is the disambiguation that stops the re-purchase inference and the
 * over-buy warning from contradicting each other: both fire on the same event,
 * so the prompt resolves it once.
 *   - stock is past expiry      → the old lot was WASTED (discard)
 *   - cadence says it's empty   → consumed, business as usual (no prompt)
 *   - cadence says stock remains → ASK: extra purchase, or used faster?
 */
export function classifyRepurchase(
  state: CadenceState,
  opts: { expired?: boolean } = {},
): "discard" | "consume" | "ask_over_buy" {
  if (opts.expired) return "discard";
  if (state.on_hand_estimate <= 0) return "consume";
  if (state.days_until_runout != null && state.days_until_runout > 0) return "ask_over_buy";
  return "consume";
}
