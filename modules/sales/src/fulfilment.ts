// Fulfilment: decrement each sold line item's inventory part from stock. Reads/
// writes inventory ONLY through the platform action (inventory:adjust-stock) —
// never a join. This is the "sale → decrement stock" half of the loop; the
// low-stock signal that inventory then emits drives the reorder half.

import { platform } from "@cobblr/platform-contract";

export interface FulfilLine {
  part_id: string | null;
  qty: number;
}

/** Decrement stock for an order's line items. Best-effort per line (a failure
 *  logs + continues). Returns what was decremented. Lines without a part_id
 *  (free-text / service lines) are skipped. */
export async function decrementForFulfilment(
  orgId: string,
  userId: string | null,
  orderId: string,
  lines: FulfilLine[],
): Promise<Array<{ part_id: string; qty: number }>> {
  const decremented: Array<{ part_id: string; qty: number }> = [];
  for (const line of lines) {
    if (!line.part_id || line.qty <= 0) continue;
    await platform()
      .actions.invoke("inventory:adjust-stock", {
        orgId,
        userId,
        entity: { kind: "inventory:part", id: line.part_id },
        event: {
          name: "sales.order.fulfilled",
          payload: {},
          actor: { user_id: userId, display_name: null, auth_method: "session" },
          timestamp: new Date().toISOString(),
          trigger_type: "event",
        },
        args: { partId: line.part_id, delta: -line.qty, reason: `sale:${orderId}` },
        entityKind: "inventory:part",
        entityId: line.part_id,
      })
      .catch((e) => console.error("[sales] fulfilment adjust-stock failed:", (e as Error).message));
    decremented.push({ part_id: line.part_id, qty: line.qty });
  }
  return decremented;
}
