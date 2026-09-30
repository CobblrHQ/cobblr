// An order's number, when whoever made it gave none. Every order has one, so
// it can be told apart from the customer's other orders: on its sheet, in a
// search, and in the activity feed, which otherwise said "created Acme
// Robotics" once per order (#4142). The one implementation behind the route
// and the sales:create-order action.

import { sql, type Kysely } from "kysely";
import type { SalesDB } from "./db.js";

const PREFIX = "SO-";

/** The next SO-number in this instance: one past the highest SO-number it
 *  holds, four digits wide. A number a person typed in another shape is left
 *  alone and does not move the sequence. */
export async function nextOrderNumber(db: Kysely<SalesDB>, instance?: string): Promise<string> {
  let q = db
    .selectFrom("sales_orders")
    .select(sql<string | null>`max((substring(order_number from '^SO-([0-9]+)$'))::int)::text`.as("top"))
    .where("order_number", "~", "^SO-[0-9]+$");
  if (instance) q = q.where("instance", "=", instance);
  const row = await q.executeTakeFirst();
  const next = (Number(row?.top) || 0) + 1;
  return `${PREFIX}${String(next).padStart(4, "0")}`;
}
