// When stock arriving is a FRESH LOT, dated today, rather than a bare count.
//
// Checking milk off the shopping list fired adjust-stock with delta 1. That is
// a bare quantity change: the count went 0 to 1 and the replacement inherited
// the old lot's dates, so on the day it was bought the fresh milk read
// "expired 5d ago" (2026-09-12). Restock one already knew better and dated a
// lot; the wire path did not.
//
// The rule is DATA, never words. A wire's reason is free text and the next
// bundle phrases it differently, so the signal is the arg `restock: true` on
// the wire (the bundles set it; the record's own Restock button sends the same
// arg), or the plain fact that the record was empty: whatever arrives on an
// empty shelf is the stock now, and its dates are its own.
//
// The rule itself lives in the contract (@cobblr/platform-contract/fresh-lot)
// because the shopping row predicts it; here are the writes that follow from
// it. Pure, so it is a test.

export { startsFreshLot, shelfLifeDaysOf } from "@cobblr/platform-contract/fresh-lot";

/** The role-field writes that go with a lot arriving today.
 *
 *  `acquired-on` becomes today whenever a dated lot arrives (the latest
 *  purchase is the one a person means by "bought on"). The `expiry` role
 *  follows the visible date, the earliest live lot; on a record that was EMPTY
 *  that is the new lot's date, or nothing when the item declares no shelf life,
 *  so a stale date is never left standing on stock it does not describe. A
 *  record that still had some keeps its earlier lot's date, which is the one
 *  that goes off first. Field names come from the workspace's own role
 *  declarations; a kind without the role gets no write for it. */
export function freshLotStamps(input: {
  today: string;
  /** The visible expiry after the lot was added (earliest live lot), or null. */
  visibleExpiry: string | null;
  qtyBefore: number;
  roles: { acquiredOn?: string | null; expiry?: string | null };
}): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (input.roles.acquiredOn) out[input.roles.acquiredOn] = input.today;
  if (input.roles.expiry && input.qtyBefore <= 0) out[input.roles.expiry] = input.visibleExpiry;
  return out;
}

/** Did a lot dated today grow between two states of the lots? That is what
 *  "stock arrived" looks like from the lots alone: restock, a fresh lot on an
 *  empty shelf, a swap for a fresh one. A bare correction lands as an undated
 *  lot and a use-one only shrinks, so neither reads as an arrival. */
export function arrivedToday(
  before: ReadonlyArray<{ received_on: string; qty: number }>,
  after: ReadonlyArray<{ received_on: string; qty: number }>,
  today: string,
): boolean {
  const sum = (lots: ReadonlyArray<{ received_on: string; qty: number }>) =>
    lots.filter((l) => l.received_on === today).reduce((n, l) => n + l.qty, 0);
  return sum(after) > sum(before);
}
