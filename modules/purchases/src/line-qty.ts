import { z } from "zod";

/** Well under what a part's count can hold, so one line can't overflow it and leave its delivery failing for good. */
export const LINE_QTY_MAX = 100_000_000;

export const lineQty = z.number().finite().positive().max(LINE_QTY_MAX);

export const isLineQty = (qty: number): boolean => lineQty.safeParse(qty).success;

/** A purchase only ever adds to the shelf. A line saved before the doors refused a
 *  negative one would otherwise take that many off when its order arrived. */
export const stockAddedBy = (qty: number): number => (isLineQty(qty) ? qty : 0);
