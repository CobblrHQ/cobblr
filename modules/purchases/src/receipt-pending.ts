import { sql } from "kysely";
import { ActionRefusal } from "@cobblr/platform-contract";

export class ReceiptPending extends ActionRefusal {
  constructor() {
    super("Delivery recorded, but stock updates are still pending. They will be retried automatically.");
  }
}

export function receiptPending(orderColumn = "purchases_orders.id") {
  return sql<boolean>`exists (select 1 from purchases_receive_outbox receipt where receipt.order_id = ${sql.ref(orderColumn)} and receipt.completed_at is null)`;
}
