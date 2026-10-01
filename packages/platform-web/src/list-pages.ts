// Every row of a paged list route, and the count the server gave. The shell
// and every module's UI read a paged list through this one walker.
//
// A list route answers a page plus the collection's `total`
// (@cobblr/platform-contract/list-page). A page that shows a whole register
// and searches it in the browser needs every row, so this walks the pages
// until the server says the list is complete. Past MAX_ROWS it stops and says
// so (`complete: false`), and `total` still names the real size, so a count
// never reads the page as the whole.

export interface WalkedList<T> {
  items: T[];
  total: number | null;
  complete: boolean;
}

const PAGE = 500;
const MAX_ROWS = 10_000;

export async function walkPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total?: number | null; complete?: boolean }>,
): Promise<WalkedList<T>> {
  const items: T[] = [];
  let total: number | null = null;
  for (;;) {
    const page = await fetchPage(items.length, PAGE);
    items.push(...page.items);
    total = page.total ?? total;
    // An older server answers one page with no total and no `complete`: that
    // page is all it will give.
    const done = page.complete ?? true;
    if (done || page.items.length === 0) return { items, total: total ?? items.length, complete: true };
    if (items.length >= MAX_ROWS) return { items, total, complete: false };
  }
}
