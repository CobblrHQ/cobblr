// A session's line counts, and whether the page holds all of it.
//
// The inbox loads rows 50 at a time and groups them into sessions, so a
// session that straddles a page boundary showed "File 12" and "Do these 12
// belong together?" for a session of 20, and its File all took the 12 that
// happened to be loaded (#3638). The server counts each session over every
// row (`lines` on its batch meta); the header reads that. And a session the
// page holds only part of is loaded whole, so the ids an action takes are
// the session's, not the page's.

import type { ScanBatchMeta, ScanInboxItem } from "./api";

export interface SessionLines {
  pending: number;
  ever: number;
}

/** The session's counts: the server's, for a real session. A gap session (old
 *  rows with no batch) is clustered FROM the loaded rows, so its rows are
 *  what it is. */
export function sessionLines(items: readonly ScanInboxItem[], meta: ScanBatchMeta | undefined): SessionLines {
  if (meta?.lines) return meta.lines;
  let pending = 0;
  for (const it of items) if (it.status === "pending") pending++;
  return { pending, ever: items.length };
}

/** Batch ids whose pending rows the page holds only some of. */
export function incompleteSessions(
  items: readonly ScanInboxItem[],
  batchMeta: Readonly<Record<string, ScanBatchMeta>>,
): string[] {
  const loaded = new Map<string, number>();
  for (const it of items) {
    if (it.scan_batch_id && it.status === "pending") loaded.set(it.scan_batch_id, (loaded.get(it.scan_batch_id) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [id, n] of loaded) {
    const total = batchMeta[id]?.lines?.pending;
    if (total != null && n < total) out.push(id);
  }
  return out;
}

/** What a session's merge offers: the session it joins and the words that
 *  name it, from ONE resolution, so the label cannot say one session while
 *  the action joins another (#3711: "Merge with the session above" joined a
 *  session further DOWN, past a receipt, that was not even the neighbour).
 *
 *  The target is the session shown directly above this one in the list as it
 *  is drawn, and only that one: if it is not a scan session, nothing is
 *  offered. A receipt is its own purchase, so a receipt session is never
 *  merged into another and nothing is merged into one (the owner,
 *  2026-09-24: "a receipt doesn't make sense to merge into another
 *  session"). The session above is always on the page, whatever has been
 *  paged in below it. */
export function sessionMergeOffer<G extends { isBatch: boolean; batchId: string | null; label?: string | null }>(
  groups: readonly G[],
  index: number,
  nameOf: (g: G) => string,
): { into: string; target: G; label: string } | null {
  const receipt = (x: { isBatch: boolean; label?: string | null }) => x.isBatch && !!x.label?.startsWith("Receipt");
  const g = groups[index];
  const above = index > 0 ? groups[index - 1] : undefined;
  if (!g || !g.isBatch || !g.batchId || receipt(g)) return null;
  if (!above || !above.isBatch || !above.batchId || receipt(above) || above.batchId === g.batchId) return null;
  return { into: above.batchId, target: above, label: `Merge with ${nameOf(above)}, above` };
}
