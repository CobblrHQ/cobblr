// Intent routing for a Discord bot DM: is the user ANSWERING a pending team
// question (→ append to that item), or reporting something NEW (→ create a fresh
// item)? Kept pure + dep-free so the decision is unit-tested on its own — the old
// always-append behaviour silently buried new reports as follow-ups on unrelated
// tickets, so this call is the whole fix and earns a test.

// A clarifying question is a LIVE back-and-forth: the user answers within hours,
// not weeks. The window used to be 14 days, which let a brand-new DM append to a
// week-old ticket just because the team had spoken on it. 2 days is generous for
// a same-day-or-next reply while cutting the stale-append tail.
export const DM_REPLY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

// Only an OPEN item can be awaiting the user's answer. A resolved/wontfix item's
// last team message was a RESOLUTION ("your request is live"), NOT a question, so
// a DM after it is a NEW report, not a reopen.
const OPEN_STATUSES = new Set(["new", "triaged", "in_progress", "awaiting_decision"]);

export interface DmRoutingItem {
  status?: string | null;
  followups?: unknown;
  updated_at: Date | string;
}

/** A DM counts as a REPLY only when the user's most-recent item is (a) still
 *  OPEN, (b) had the TEAM speak last (a clarifying question awaiting an answer),
 *  and (c) is still fresh. Everything else — a closed item (its team message was
 *  a resolution, not a question), the user spoke last, no follow-ups yet, stale,
 *  or no item at all — is a NEW report.
 *
 *  Why the OPEN gate: a team RESOLUTION reply makes an item "team-spoke-last", so
 *  without it a fresh DM sent after we resolve (or, worse, after a BATCH resolve)
 *  reopened the most-recent resolved ticket and buried the new topic as a
 *  follow-up — it never hit the feedback channel or the autopilot (the author,
 *  2026-07-11). A closed item's reply becomes its own visible item instead. */
export function isDmReply(latest: DmRoutingItem | undefined | null, nowMs: number): boolean {
  if (!latest) return false;
  if (!latest.status || !OPEN_STATUSES.has(latest.status)) return false;
  const fups = Array.isArray(latest.followups) ? (latest.followups as Array<{ role?: string }>) : [];
  const teamSpokeLast = fups.length > 0 && fups[fups.length - 1]?.role === "team";
  if (!teamSpokeLast) return false;
  return nowMs - new Date(latest.updated_at).getTime() < DM_REPLY_WINDOW_MS;
}
