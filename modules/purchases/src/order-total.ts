// What an order cost: the one rule every spend figure reads.
//
// total_cost is the figure somebody stated (a receipt's total, typed in). An
// order typed in by hand has none: its lines say what it cost. Every spend
// figure (the list's total, Purchases' spend and its six-month chart, a
// vendor's total spend) read total_cost alone, so a hand-entered order, and
// every past purchase filled in line by line, counted as nothing spent. Here
// the stated total wins when there is one; otherwise the lines (a line's own
// stated amount, else qty times price) plus shipping. An order with no priced
// line and no shipping has no total at all, which is different from 0.

import { sql, type RawBuilder } from "kysely";

export function orderTotal(alias: string): RawBuilder<string | null> {
  const o = sql.raw(alias);
  return sql<string | null>`coalesce(${o}.total_cost, (
    select case
      when count(*) filter (where i.line_amount is not null or i.unit_cost is not null) > 0 or ${o}.shipping_cost is not null
      then coalesce(sum(coalesce(i.line_amount, i.qty * i.unit_cost)), 0) + coalesce(${o}.shipping_cost, 0)
    end
    from purchases_order_items i
    where i.order_id = ${o}.id
  ))`;
}
