// Which answers are a write's own answer (#7921 class 3).
//
// A write sent with an Idempotency-Key is answered from memory when it is
// sent again (api/src/platform/request-replays.ts), and a change kept waiting
// on a device is sent again with its key until it lands or is refused
// (web/src/lib/offline-writes.ts). The two must agree on which answers end a
// write. The server kept "too many, wait a minute" (429) as a write's answer
// for a day while the device, rightly, kept the change waiting and sent it
// again: every try was answered "wait a minute" from memory and the change
// never landed. One rule here, read by both, so they cannot drift.

/** The answers that refuse the change itself: its body, the record it names,
 *  the rule or the newer change it meets. */
export const REFUSES_THE_CHANGE: ReadonlySet<number> = new Set([400, 403, 404, 405, 409, 410, 412, 413, 415, 422]);

/** Refusals of this session, not of the change: a read-only support session,
 *  a share's View as, a guest; the same write still running elsewhere. */
export const ABOUT_THE_SESSION: ReadonlySet<string> = new Set(["impersonation_read_only", "share_view_read_only", "guest_not_shared", "request_in_progress"]);

/** Whether an answer ends the write: it ran, or the change itself was
 *  refused. Anything else (busy, too fast, signed out, timed out, a server
 *  failing) says nothing about the change, so the same write is sent again
 *  with the same key and must be asked again, not answered from memory. */
export function answerEndsTheWrite(status: number, code: string | null | undefined, retryAfter: boolean): boolean {
  if (status < 400) return true;
  if (!REFUSES_THE_CHANGE.has(status)) return false;
  if (code && ABOUT_THE_SESSION.has(code)) return false;
  return !(status === 409 && retryAfter);
}
