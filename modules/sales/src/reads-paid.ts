// An order's paid column, as every read must take it. A line saved before the limits on a
// line may hold Infinity, NaN or a number too big to add up (#9322). Such an order never
// reads paid, whatever an older write left in the column, and nothing here changes the row.
// orderMoney decides the same thing from the line's figures; this is lineCannotAddUp for SQL.

import { sql } from "kysely";
import { LINE_ADDS_UP_BELOW } from "./invoice.js";

export const holdsImpossibleLine = sql<boolean>`exists (select 1 from sales_order_items i where i.order_id = sales_orders.id and not (abs(i.qty * coalesce(i.unit_price, 0)) < ${sql.lit(LINE_ADDS_UP_BELOW)}))`;

export const readsPaid = sql<boolean>`(sales_orders.paid and not ${holdsImpossibleLine})`;

/** Select after selectAll(), so this answer is the one a row carries. */
export const paidAsRead = readsPaid.as("paid");
