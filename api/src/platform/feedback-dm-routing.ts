// Intent routing for a Discord bot DM: is the user ANSWERING a pending team
// question (→ append to that item), or reporting something NEW (→ create a fresh
// item)? Kept pure + dep-free so the decision is unit-tested on its own — the old
// always-append behaviour silently buried new reports as follow-ups on unrelated
// tickets, so this call is the whole fix and earns a test.

export const DM_REPLY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface DmRoutingItem {
  status?: string | null;
  followups?: unknown;
  updated_at: Date | string;
}

/** A DM counts as a REPLY only when the user's most-recent item had the TEAM
 *  speak last (a clarifying question awaiting an answer) AND it's still fresh.
 *  Everything else — user spoke last, no follow-ups yet, stale, or no item at
 *  all — is a NEW report. */
export function isDmReply(latest: DmRoutingItem | undefined | null, nowMs: number): boolean {
  if (!latest) return false;
  const fups = Array.isArray(latest.followups) ? (latest.followups as Array<{ role?: string }>) : [];
  const teamSpokeLast = fups.length > 0 && fups[fups.length - 1]?.role === "team";
  if (!teamSpokeLast) return false;
  return nowMs - new Date(latest.updated_at).getTime() < DM_REPLY_WINDOW_MS;
}
