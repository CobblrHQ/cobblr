// What we tell a reporter when their item is resolved.
//
// The API used to PREPEND "Fixed — this is live now. 🎉" to whatever the
// resolver had written. Two things wrong with that, and the second is the bad
// one:
//
//   1. "live" is not true at resolve time. Merging is not shipping. A
//      self-hoster gets it with the next nightly; the hosted service gets it
//      with the next release. Neither has happened when the item is resolved.
//   2. It CONTRADICTED the person writing the reply. Somebody wrote "the fix is
//      merged and will be in the next nightly release, typically available
//      tomorrow morning" — accurate, careful — and the reporter received that
//      sentence with "this is live now" glued to the front of it. Making the
//      author's own words wrong is worse than a clumsy default, because the
//      author cannot fix it: there is no phrasing they can choose that survives.
//
// So: a written reply is delivered VERBATIM, and the fallback claims only what
// is true on every surface.

export type FeedbackReplyStatus = "resolved" | "wontfix" | string;

/** The default when nobody wrote anything. Says what is true regardless of
 *  where the reporter runs Cobblr, because at this point we do not know. */
export function defaultReplyText(status: FeedbackReplyStatus): string {
  if (status === "resolved") return "Fixed — the change is merged and goes out with the next release. 🎉";
  if (status === "wontfix") return "We reviewed this — thanks for flagging it.";
  return "We're looking into this.";
}

/**
 * The message to send a reporter.
 *
 * `written` is whatever a human or agent typed: a reply, or a what-we-did note.
 * When present it is the whole message. Nothing is added in front of it, ever —
 * that is the entire point of this function.
 */
export function feedbackReplyText(status: FeedbackReplyStatus, written?: string | null): string {
  const text = (written ?? "").trim();
  return text || defaultReplyText(status);
}
