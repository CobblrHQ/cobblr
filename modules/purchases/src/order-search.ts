import { textSearchWhere, type LikeBuilder } from "@cobblr/platform-contract";

// What a search reads on an order, on every door: the orders list and the
// list resolver Search, a view and Cobb read. The list used to hand-roll its
// own four-column LIKE, so a custom field Search found was not found there
// (#7929).
const ORDER_SEARCH_TEXT = ["vendor", "order_number", "notes", "tracking_number"] as const;

/** The where-expression for a search on orders, or null for an empty one.
 *  `table` is the alias the query gives purchases_orders (`o` on the list). */
export function orderSearchWhere(eb: LikeBuilder, q: string | undefined, opts: { table?: string; unreadable: ReadonlySet<string> | undefined }) {
  const at = (c: string) => (opts.table ? `${opts.table}.${c}` : c);
  return textSearchWhere(eb, q, { unreadable: opts.unreadable, text: ORDER_SEARCH_TEXT.map(at), json: [at("metadata")] });
}
