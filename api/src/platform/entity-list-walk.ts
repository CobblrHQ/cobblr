// The walk behind entities.listAll: every page of a list query, as one answer
// with a total that is never the length of a page.
//
// Pure (it takes the page fetcher), so the cases that ended walks early are
// held by a test without a database: a resolver that clamps the page it was
// asked for, one that ignores offset, rows another workspace shares in on
// every page, and a cap.
import type { EntityListResult, FilterPredicate, ResolvedEntity } from "@cobblr/platform-contract";

export type WalkedList = Omit<EntityListResult, "total"> & { total: number | null; complete: boolean };

/** Walk pages until the rows run out, the resolver's count is reached, or
 *  `cap` rows are held.
 *
 *  It advances by what each page actually returned, never by the size it
 *  asked for, so a resolver that clamps (asked 500, gave 100) cannot end it.
 *  `total` is the resolver's count when it gave one, else the walked count
 *  once complete, else null. */
export async function walkListPages(
  fetchPage: (limit: number, offset: number) => Promise<EntityListResult>,
  opts: { pageSize?: number; cap?: number } = {},
): Promise<WalkedList> {
  const pageSize = opts.pageSize ?? 500;
  const cap = opts.cap ?? 5000;
  const items: ResolvedEntity[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  let unapplied: FilterPredicate[] | undefined;
  let offset = 0;
  let complete = false;
  while (items.length < cap) {
    const page = await fetchPage(pageSize, offset);
    if (offset === 0) {
      total = page.total;
      unapplied = page.unapplied;
    }
    // Rows another workspace shares in arrive with every page; only this
    // workspace's own rows move the offset.
    let own = 0;
    let fresh = 0;
    for (const it of page.items) {
      const from = it.fields?._source_workspace_slug;
      if (from === undefined) own++;
      const key = `${it.kind}:${it.id}:${String(from ?? "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
      fresh++;
    }
    if (own === 0) {
      complete = true;
      break;
    }
    // A page of rows already seen is a resolver that ignores offset. What it
    // repeated is everything only if its first page was not full.
    if (fresh === 0) {
      complete = total !== undefined ? items.length >= total : items.length < pageSize;
      break;
    }
    offset += own;
    if (total !== undefined && offset >= total) {
      complete = true;
      break;
    }
  }
  const out = items.slice(0, cap);
  const whole = complete && out.length === items.length;
  return {
    items: out,
    total: total ?? (whole ? out.length : null),
    complete: whole,
    ...(unapplied ? { unapplied } : {}),
  };
}
