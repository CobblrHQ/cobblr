// What a pending capture still needs from a person — the ONE definition.
//
// The scan inbox shows three facets above the queue: how many are pending, how
// many have been waiting too long, and how many need a human to look. Those
// predicates were written inline in the Scan page, so they existed only in the
// browser. The API could not filter by them and the assistant could not read
// them, which is why "can you see the items in my scan inbox?" was answered with
// the page's own summary line and nothing else.
//
// Pure and shared: the page, the list route's `triage` filter, and the
// assistant's list tool all import from here, so a facet can never mean one
// thing on screen and another to whoever asks about it.

/** The columns/fields any triage decision is made from — the subset of a scan
 *  row these predicates read. Deliberately structural: the API row, the web
 *  row type and a test fixture all satisfy it without a shared row class. */
export interface ScanTriageRow {
  status?: string | null;
  suggested_name?: string | null;
  ai_confidence?: number | string | null;
  suggested_metadata?: unknown;
  created_at?: string | Date | null;
  target_location_id?: string | null;
  target_container_id?: string | null;
}

/** Confidence at or above which an identification stands on its own. Below it a
 *  human is asked, because a wrong name filed confidently is worse than a slow
 *  one. */
export const SCAN_REVIEW_CONFIDENCE = 0.5;

/** Waiting longer than this is "rotting" — the nudge to clear the queue. Two
 *  days is when a capture stops being fresh in the user's memory. */
export const SCAN_STALE_DAYS = 2;

const STALE_MS = SCAN_STALE_DAYS * 24 * 60 * 60 * 1000;

interface TriageMeta {
  low_trust?: boolean;
  rate_limited?: boolean;
  reviewed?: boolean;
  photo_wanted?: boolean;
}

function metaOf(row: ScanTriageRow): TriageMeta {
  return (row.suggested_metadata ?? {}) as TriageMeta;
}

function isPending(row: ScanTriageRow): boolean {
  return row.status === "pending";
}

/** Didn't cleanly resolve: no name yet, a low-trust or rate-limited lookup, or
 *  low confidence. "Looks fine" (a human eyeballed it) clears the flag — the
 *  point is to stop nagging, not to record a permanent doubt. */
export function needsScanReview(row: ScanTriageRow): boolean {
  if (!isPending(row)) return false;
  const meta = metaOf(row);
  if (meta.reviewed) return false;
  const confidence = row.ai_confidence == null ? null : Number(row.ai_confidence);
  return (
    !row.suggested_name ||
    !!meta.low_trust ||
    !!meta.rate_limited ||
    (confidence != null && !Number.isNaN(confidence) && confidence < SCAN_REVIEW_CONFIDENCE)
  );
}

/** How long this capture has been sitting, in whole days. Null when it carries
 *  no usable timestamp — an unknown age must never read as "brand new". */
export function scanWaitingDays(row: ScanTriageRow, now: number = Date.now()): number | null {
  if (row.created_at == null) return null;
  const t = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / (24 * 60 * 60 * 1000)));
}

/** Pending for longer than the stale window. */
export function isScanStale(row: ScanTriageRow, now: number = Date.now()): boolean {
  if (!isPending(row)) return false;
  if (row.created_at == null) return false;
  const t = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
  return !Number.isNaN(t) && now - t > STALE_MS;
}

/** Already has somewhere to go — a filing location or a container it was
 *  scanned into. The complement is what the put-away flow calls "unfiled". */
export function scanHasHome(row: ScanTriageRow): boolean {
  return !!row.target_location_id || !!row.target_container_id;
}

/** A person said "I'll photograph this myself" and has not yet. Unlike every
 *  other facet this one is a stated INTENT rather than a state the pipeline
 *  derived, which is exactly why it is here: the scanner and the dashboard both
 *  ask for it, and a predicate that lives in one of them is invisible to the
 *  other (and to whoever asks the assistant). */
export function wantsOwnPhoto(row: ScanTriageRow): boolean {
  return isPending(row) && metaOf(row).photo_wanted === true;
}

/** The facets a caller can ask for. `all` is every pending item. */
export type ScanTriageFacet = "all" | "needs_review" | "waiting" | "unfiled" | "ready" | "photo_wanted";

export const SCAN_TRIAGE_FACETS: ScanTriageFacet[] = ["all", "needs_review", "waiting", "unfiled", "ready", "photo_wanted"];

/** Does this row belong to the facet? One switch, so a new facet is added in a
 *  single place and every surface gains it at once. */
export function matchesScanFacet(
  row: ScanTriageRow,
  facet: ScanTriageFacet,
  now: number = Date.now(),
): boolean {
  switch (facet) {
    case "needs_review":
      return needsScanReview(row);
    case "waiting":
      return isScanStale(row, now);
    case "unfiled":
      return isPending(row) && !scanHasHome(row);
    case "ready":
      // Somewhere to go AND nothing left to ask — the "just put them away" set.
      return isPending(row) && scanHasHome(row) && !needsScanReview(row);
    case "photo_wanted":
      return wantsOwnPhoto(row);
    case "all":
      return true;
  }
}
