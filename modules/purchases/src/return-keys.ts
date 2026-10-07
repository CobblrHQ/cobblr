/** What `purchases.order_item.returned` carries: the mirror of a received
 *  line, with delta negative when the item went back to the store and
 *  positive when an undo brings it back. The manifest declares it from this
 *  list (exposes.eventPayloads) and returns.ts sets every key on every emit. */
export const ORDER_ITEM_RETURNED_KEYS = ["orderId", "orderItemId", "returnId", "partId", "delta", "qty", "reason", "description"] as const;
