// How much we believe an arrival date, and the rule that a worse source never
// overwrites a better one.
//
// An order accumulates estimates from sources of very different quality. The
// receipt email said "Sat, Aug 15" when the seller had not yet handed it over.
// A tracking number typed in an hour later knows nothing at all. A day after
// that the carrier has its own date, which is better. On the morning it goes
// out for delivery, "today" is close to certain.
//
// The failure this prevents is the middle one: a freshly entered tracking
// number returns no ETA, and a naive "carrier knows best" write would blank a
// perfectly good receipt estimate and leave the order with no date. Silence is
// not information, and must never displace information.

/** Where an arrival date came from, worst to best. Order IS the rank. */
export const ETA_SOURCES = [
  /** No date at all. */
  "none",
  /** The seller's promise, from a receipt or order confirmation. Real, but
   *  made before anyone handed the parcel over. */
  "receipt",
  /** The carrier's own estimate, once it has the parcel. */
  "carrier",
  /** The carrier says it is on a vehicle today. */
  "out-for-delivery",
  /** The carrier says it landed. */
  "delivered",
] as const;

export type EtaSource = (typeof ETA_SOURCES)[number];

const rank = (s: EtaSource): number => ETA_SOURCES.indexOf(s);

/** Whether `next` should replace `current`.
 *
 *  Equal rank replaces: a carrier revising its own estimate is the same source
 *  saying something newer, and newer wins. A LOWER rank never replaces, which
 *  is the whole point — an empty tracking number cannot erase what the receipt
 *  told us. */
export function shouldReplaceEta(current: EtaSource, next: EtaSource): boolean {
  return rank(next) >= rank(current);
}

/** The ETA source implied by a carrier's state, or null when the carrier has
 *  told us nothing worth recording.
 *
 *  `unknown` deliberately maps to null rather than to "none": a carrier with no
 *  information has not made a claim, and "none" is a claim that there is no
 *  date. That distinction is what stops a silent tracking number from
 *  downgrading anything. */
export function etaSourceOfState(state: string, hasCarrierEta: boolean): EtaSource | null {
  if (state === "delivered") return "delivered";
  if (state === "out_for_delivery") return "out-for-delivery";
  if (state === "unknown") return null;
  return hasCarrierEta ? "carrier" : null;
}

export interface EtaClaim {
  date: string | null;
  source: EtaSource;
}

/** Merge a new claim into what an order already has.
 *
 *  Returns the claim to store, which is often the one it already had. A claim
 *  with no date is never stored whatever its rank: "delivered, and I do not
 *  know when" must not wipe the date the order is showing. */
export function mergeEta(current: EtaClaim, next: EtaClaim | null): EtaClaim {
  if (!next || !next.date) return current;
  if (!current.date) return next;
  return shouldReplaceEta(current.source, next.source) ? next : current;
}
