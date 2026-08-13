// What terminally happened to an inbound message, as one word.
//
// Its own module because the route it serves runs env checks at import time, so
// nothing can unit-test a helper that lives beside it. A decision this small
// and this load-bearing should be testable without standing up a server.

/**
 * What terminally happened to a message, as one word.
 *
 * The reprocess work-list used to infer this from `item_count === 0`, and that
 * one number stands for three unrelated situations: a parse that failed for
 * want of a capability, a body with no receipt in it, and a duplicate that was
 * right to import nothing. Only the first is worth replaying, and a list that
 * cannot tell them apart shows work that is not work, which is how a list stops
 * being read.
 *
 *   imported           items landed
 *   duplicate          already imported; replaying would double it
 *   degraded           we could not do the job for a reason that MAY GO AWAY
 *                      (no AI provider yet). A replay after fixing it wins
 *   nothing_to_import  we read it and there was no receipt. A replay does the
 *                      same thing forever
 */
export function outcomeStatus(o: {
  parsedCount: number;
  duplicate: boolean;
  bodyFailure: "ai_unavailable" | "no_line_items" | "unreadable" | null;
}): "imported" | "duplicate" | "degraded" | "nothing_to_import" {
  if (o.parsedCount > 0) return "imported";
  if (o.duplicate) return "duplicate";
  // `unreadable` needs a different INPUT, not another attempt at these bytes,
  // so it is not degraded either: replaying it changes nothing.
  if (o.bodyFailure === "ai_unavailable") return "degraded";
  return "nothing_to_import";
}
