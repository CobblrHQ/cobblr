/** What `purchases.order_item.received` carries. The manifest declares it
 *  from this list (exposes.eventPayloads), and receive.ts sets every key on
 *  every emit, so a wire can rely on any of them. Its own file so the
 *  manifest reads it without loading the database layer. */
export const ORDER_ITEM_RECEIVED_KEYS = ["orderId", "orderItemId", "partId", "delta", "qty", "unitCost", "lineCost", "reason", "description"] as const;
