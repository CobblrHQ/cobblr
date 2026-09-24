// The Scan Inbox's counts, over EVERY pending row, by the predicates the rows
// themselves use.
//
// The inbox loads its rows 50 at a time, and its header counted the page:
// with 78 pending it said "43 ready, 7 to review" (a sum of 50), and the
// review filter said "7 of 50 shown"; scrolling to the end, and nothing else,
// made it "66 ready, 12 to review" (#3638). Items that needed review were
// invisible to the filter until they scrolled into view. The counts a person
// reads, and the ids an action takes, come from here; a filter asks the list
// route for its rows (?triage=), never filters what is loaded.

import {
  isScanReadyToFile,
  isScanStale,
  matchesScanFacet,
  needsScanReview,
  scanHasHome,
  scanReceiptReadFailed,
  type ScanRowStateContext,
  type ScanTriageRow,
} from "@cobblr/platform-contract/scan-triage";

export type CountRow = ScanTriageRow & {
  id: string;
  scan_batch_id: string | null;
  target_location_id: string | null;
  target_container_id: string | null;
};

export interface InboxCounts {
  pending: number;
  /** No home (no location, no container), failed receipts aside. */
  unfiled: number;
  /** A home and nothing left to ask: the put-away "ready". */
  ready: number;
  /** Named, routed, nothing flagged: what File all commits for this viewer. */
  ready_to_file: number;
  /** Held for a person, failed receipt reads included. */
  needs_review: number;
  /** Waiting two days or more. */
  waiting: number;
  /** Rows with no location of their own: the set "Also set location on the N
   *  already here" acts on, by id. */
  loose_ids: string[];
  /** Receipts whose read failed, each counted once. */
  failed_reads: number;
  /** Receipt sessions whose read failed: no rows of their own, so the review
   *  count cannot see them and the header adds them. */
  failed_sessions: number;
}

export function inboxCounts(
  rows: readonly CountRow[],
  failedSessionIds: ReadonlySet<string>,
  viewer: ScanRowStateContext,
  now: number = Date.now(),
): InboxCounts {
  let unfiled = 0;
  let ready = 0;
  let readyToFile = 0;
  let review = 0;
  let waiting = 0;
  let failedRows = 0;
  const loose: string[] = [];
  for (const r of rows) {
    const unread = scanReceiptReadFailed(r);
    const home = scanHasHome(r);
    if (!home && !unread) unfiled++;
    if (unread && (!r.scan_batch_id || !failedSessionIds.has(r.scan_batch_id))) failedRows++;
    if (home && matchesScanFacet(r, "ready", now, viewer)) ready++;
    if (isScanReadyToFile(r, viewer)) readyToFile++;
    if (needsScanReview(r)) review++;
    if (isScanStale(r, now)) waiting++;
    if (!r.target_location_id) loose.push(r.id);
  }
  const failedReads = failedSessionIds.size + failedRows;
  return {
    pending: rows.length,
    unfiled,
    ready,
    ready_to_file: readyToFile,
    needs_review: review,
    waiting,
    loose_ids: loose,
    failed_reads: failedReads,
    failed_sessions: failedSessionIds.size,
  };
}
