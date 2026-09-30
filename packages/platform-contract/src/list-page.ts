// A list route answers a page and says how many there are.
//
// A route that cut its rows at a fixed number and said nothing else let a
// page count what arrived and call that the total: the assets page read
// "500 of 500" with 520 on file, and the 20 past the cut could not be
// reached. Every list route that pages reads its window here and answers
// through `pagedAnswer`, so the count is the collection's, never the page's.
//
// The route adds `count(*) over()` as TOTAL_COLUMN to its own query (one
// query, no second count), then:
//
//   const page = readListPage(req.query);
//   const rows = await q.select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
//     .limit(page.limit).offset(page.offset).execute();
//   res.json(pagedAnswer(rows, page));
//
// lint:list-route-says-total holds it.

import { z } from "zod";

export const TOTAL_COLUMN = "__list_total";
export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 1000;

const Window = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export interface ListPage {
  limit: number;
  offset: number;
}

/** The window a caller asked for, or the first page. A bad value is the
 *  first page, never an error: a list is always answerable. */
export function readListPage(query: unknown, defaultLimit = DEFAULT_PAGE): ListPage {
  const w = Window.safeParse(query ?? {});
  return { limit: (w.success ? w.data.limit : undefined) ?? defaultLimit, offset: (w.success ? w.data.offset : undefined) ?? 0 };
}

export interface PagedAnswer<T> {
  items: T[];
  /** Every row the query matches, not the rows in this page. Null only when a
   *  page past the end came back empty and nothing said how many there are. */
  total: number | null;
  /** This page reaches the end. */
  complete: boolean;
}

export function pagedAnswer<T extends Record<string, unknown>>(rows: readonly T[], page: ListPage): PagedAnswer<Omit<T, typeof TOTAL_COLUMN>> {
  const first = rows[0];
  const total = first ? Number(first[TOTAL_COLUMN]) : page.offset === 0 ? 0 : null;
  const items = rows.map((r) => {
    const { [TOTAL_COLUMN]: _drop, ...rest } = r;
    return rest as Omit<T, typeof TOTAL_COLUMN>;
  });
  return { items, total, complete: total === null ? true : page.offset + items.length >= total };
}
