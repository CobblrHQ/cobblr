// A quantity the person stated on the gesture beats a wire's fixed amount.
//
// A wire's args carry a fixed amount (adjust-stock's `delta: 1`, record-event's
// `qty_delta: 1`) because the events it listens to do not say how many. When
// the event DOES say, because the person said so ("I got 3", checked off the
// shopping list), the fixed amount is the default they were shown, not the
// answer. The direction stays the wire's: a wire that takes stock away scales
// the same way. One rule, imported by every handler with a fixed amount, so
// the two never drift.

/** The event payload key an emitter uses for "how many the person said". */
export const STATED_QUANTITY_KEY = "quantity";

/** The amount to apply, or null when the event stated none (use the wire's
 *  own precedence). `fixed` is the wire's arg, whose sign is kept. */
export function statedQuantity(stated: unknown, fixed: unknown): number | null {
  if (typeof stated !== "number" || !Number.isFinite(stated) || stated <= 0) return null;
  const sign = typeof fixed === "number" && fixed < 0 ? -1 : 1;
  return sign * stated;
}
