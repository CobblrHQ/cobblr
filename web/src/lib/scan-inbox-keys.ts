// Every query that shows the scan inbox's state lives under one key family,
// ["scan-inbox", slug, ...], so the one invalidation every inbox write
// already makes refreshes all of it: what is pending, what was committed,
// what was discarded, and the counts beside them.
//
// They used to be siblings ("scan-inbox-resolved", "scan-stats"), and each
// of the fifty-odd writes named whichever it remembered. Filing an item
// named only the pending list, so "Recently committed" kept its old count
// until a reload (#3582). A new inbox query takes its key from here;
// `lint:query-key-families` refuses the literal anywhere else.

export const scanInboxKeys = {
  /** Everything below: what every inbox write invalidates. */
  all: (slug: string) => ["scan-inbox", slug] as const,
  pending: (slug: string, batchId: string | null, facet: string | null = null) => ["scan-inbox", slug, "pending", batchId, facet] as const,
  resolved: (slug: string) => ["scan-inbox", slug, "resolved"] as const,
  discarded: (slug: string) => ["scan-inbox", slug, "discarded"] as const,
  stats: (slug: string, batchId: string | null = null) => ["scan-inbox", slug, "stats", batchId] as const,
  /** Waiting rows a search finds (the ⌘K palette), under the family so an
   *  inbox write refreshes them. */
  search: (slug: string, q: string) => ["scan-inbox", slug, "search", q] as const,
};
