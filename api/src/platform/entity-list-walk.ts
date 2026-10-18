// The walk behind entities.listAll: every page of a list query, as one answer
// with a total that is never the length of a page.
//
// Pure (it takes the page fetcher), so the cases that ended walks early are
// held by a test without a database: a resolver that clamps the page it was
// asked for, one that ignores offset, rows another workspace shares in on
// every page, and a cap.
import type { EntityListResult, FilterPredicate, ResolvedEntity } from "@cobblr/platform-contract";

export type WalkedList = Omit<EntityListResult, "total" | "failed"> & { total: number | null; complete: boolean; failed?: true };

/** Some of the records could not be read: an export refuses rather than hand
 *  over a file missing them that looks whole, or an empty one that reads as
 *  "you have none" (#7141). */
export class ListReadError extends Error {
  readonly status = 503;
  readonly code = "records_unreadable";
  constructor(message = "Some of these records could not be read, so nothing was exported. Try again in a moment.") {
    super(message);
  }
  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

/** Walk pages until the rows run out, the resolver's count is reached, or
 *  `cap` rows are held.
 *
 *  It advances by what each page actually returned, never by the size it
 *  asked for, so a resolver that clamps (asked 500, gave 100) cannot end it.
 *  `total` is the resolver's count when it gave one, else the walked count
 *  once complete, else null. A page that failed ends the walk incomplete,
 *  with `failed`. */
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
  let failed = false;
  while (items.length < cap) {
    const page = await fetchPage(pageSize, offset);
    // A page the resolver threw on is not the end of the rows, it is a hole in
    // them: never complete, and said so, so an export of a collection whose
    // first page failed is not an empty file that reads as "you have none",
    // nor one that stops early as if it were all (#7141).
    if (page.failed) {
      failed = true;
      break;
    }
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
  const whole = !failed && complete && out.length === items.length;
  return {
    items: out,
    total: total ?? (whole ? out.length : null),
    complete: whole,
    ...(failed ? { failed: true as const } : {}),
    ...(unapplied ? { unapplied } : {}),
  };
}
