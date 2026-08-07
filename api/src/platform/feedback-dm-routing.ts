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

// A person often files ONE report across two or three quick DMs — a first line,
// then a terse addition ("...and it needs to be clearer", a screenshot). Those
// belong on ONE item: split apart, the short continuation lands as its own
// near-unactionable report and the first message's context is lost (beta feedback,
// 2026-07-15 — two DMs ~2 min apart became two items, the vague second one
// stranded). So a DM within a few MINUTES of the user's own last activity on
// their most-recent OPEN item is a CONTINUATION → append, whoever spoke last.
//
// Deliberately MINUTES, not the days the team-question window allows: this is the
// middle ground between the old "always append" (which buried new reports on
// week-old tickets) and "only append to answered questions" (which split rapid
// self-continuations). A genuinely separate report sent later still gets its own
// item. Heuristic on purpose — time is a good-enough proxy for "same train of
// thought", and it keeps an AI relatedness call out of the ingest hot path.
export const DM_CONTINUATION_WINDOW_MS = 5 * 60 * 1000;

// Only an OPEN item can be awaiting the user's answer. A resolved/wontfix item's
// last team message was a RESOLUTION ("your request is live"), NOT a question, so
// a DM after it is a NEW report, not a reopen.
const OPEN_STATUSES = new Set(["new", "triaged", "in_progress", "awaiting_decision"]);

export interface DmRoutingItem {
  status?: string | null;
  followups?: unknown;
  updated_at: Date | string;
}

/** A DM counts as a REPLY (→ append to the user's most-recent item) when that
 *  item is still OPEN AND either:
 *    • it was touched within the last few MINUTES — a rapid self-continuation of
 *      the same thought, whoever spoke last; OR
 *    • the TEAM spoke last (a clarifying question) and it's within the longer
 *      reply window — the user is answering.
 *  Everything else — a closed item (its team message was a resolution, not a
 *  question), a not-recent item the user spoke last on (a new topic), stale, or
 *  no item at all — is a NEW report. Nothing is ever dropped: not-a-reply just
 *  means the DM opens its own item.
 *
 *  Why the OPEN gate: a team RESOLUTION reply makes an item "team-spoke-last", so
 *  without it a fresh DM sent after we resolve (or, worse, after a BATCH resolve)
 *  reopened the most-recent resolved ticket and buried the new topic as a
 *  follow-up — it never hit the feedback channel or the autopilot (the operator,
 *  2026-07-11). The gate also stops the continuation window from reopening a
 *  just-resolved item. A closed item's reply becomes its own visible item. */
export function isDmReply(latest: DmRoutingItem | undefined | null, nowMs: number): boolean {
  if (!latest) return false;
  if (!latest.status || !OPEN_STATUSES.has(latest.status)) return false;
  const ageMs = nowMs - new Date(latest.updated_at).getTime();
  // Rapid self-continuation — still adding to the same thought.
  if (ageMs < DM_CONTINUATION_WINDOW_MS) return true;
  // Answering a pending team question — team spoke last, within the reply window.
  const fups = Array.isArray(latest.followups) ? (latest.followups as Array<{ role?: string }>) : [];
  const teamSpokeLast = fups.length > 0 && fups[fups.length - 1]?.role === "team";
  if (!teamSpokeLast) return false;
  return ageMs < DM_REPLY_WINDOW_MS;
}
