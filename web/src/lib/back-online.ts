// What to read again when the api answers after it did not (#9047).
//
// One request that missed marks the api down and the next answer clears it,
// a moment later. Reading everything again then asked the whole page twice on
// a first load, a moment after it had been answered. A real outage still reads
// everything: what is on screen is old by then, or a copy this device kept.
import type { InvalidateQueryFilters } from "@tanstack/react-query";

/** Under this, the api was never really gone. The banner polls every 5 s, so a
 *  real outage ends by a poll and lasts longer. */
export const A_BLIP_MS = 3_000;

export function readAgainWhenBack({ lastedMs, keptCopies }: { lastedMs: number; keptCopies: boolean }): InvalidateQueryFilters {
  if (keptCopies || lastedMs >= A_BLIP_MS) return {};
  return { predicate: (q) => q.state.status === "error" };
}
