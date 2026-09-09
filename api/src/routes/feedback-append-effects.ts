// What a follow-up on a ticket is allowed to DO to it, decided in one place.
//
// The support bot filed every message in a ticket thread as a follow-up, and a
// follow-up reopens a resolved ticket. So the operator replying "we're
// investigating" reopened tickets he was in the middle of closing, and the bot
// was changed to skip staff messages entirely. That fixed the reopen and lost
// the record: when someone later reviewed the ticket to see what had been
// discussed, the operator's own question to the reporter was not on it — it
// lived only in the thread (2026-09-07, PR #2672).
//
// A staff reply IS part of the conversation and belongs on the record. It is
// just not a report: it must not reopen, must not send the ticket back to
// triage, and must not announce "reopened" to anyone. Those three effects are
// what a REPORTER's follow-up carries, and this is where that distinction is
// made rather than in three places in the handler.

export type TicketStatus = "new" | "triaged" | "in_progress" | "awaiting_decision" | "resolved" | "wontfix" | "backlog";

export interface AppendEffects {
  /** Move a resolved/wontfix ticket back to in_progress. */
  reopen: boolean;
  /** Clear triaged_at so the analyzer re-judges with the new context. */
  retriage: boolean;
  /** Post the "ticket reopened" notice. */
  announceReopen: boolean;
}

export function appendEffects(input: {
  status: TicketStatus | string;
  fromStaff: boolean;
  /** On the record, changes nothing. The general case: a reporter answering a
   *  question the team asked, or confirming the fix worked. */
  recordsOnly?: boolean;
  /** The narrower predecessor of recordsOnly, still accepted because a bot
   *  deployed before it sends this name. */
  answersStaff?: boolean;
}): AppendEffects {
  const closed = input.status === "resolved" || input.status === "wontfix";
  if (input.fromStaff) return { reopen: false, retriage: false, announceReopen: false };
  // Some of what a reporter says is on the record without being a report: an
  // answer to a question the team asked (the operator asked why a PNG mattered,
  // the reporter said his printer cannot print PDF, and the fixed ticket
  // reopened and announced itself, 2026-09-08), or their confirmation that the
  // fix worked. Both belong on the ticket; neither changes its state.
  if (input.recordsOnly || input.answersStaff) return { reopen: false, retriage: false, announceReopen: false };
  return { reopen: closed, retriage: true, announceReopen: closed };
}
