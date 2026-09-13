// A receipt session's verdict: one rule for "was it read, is it being read,
// did the read fail and why", read by the inbox row, the header count and the
// dashboard, so they cannot disagree.
//
// A session whose read failed used to be a NOTE ITEM ("Receipt couldn't be
// read - AI is unavailable right now") under a batch labelled "not read yet".
// The row then derived "1 finishing…" from that item (a name, no candidates,
// no matched_at: the shape of work in flight), the header's "to review"
// count skipped it (it had a name), a successful re-read left it behind as a
// third "item" the put-away planner offered a destination, and the failure's
// reason was flattened to prose (#2892, #2898). The failure is now a STATE on
// the session, with the router's coded reason (ai-refusal / scan-fallback)
// and its history, and never an item.
//
// Buildless subpath: only type imports from siblings.
import type { AiFallback, ProviderErrorReason } from "./scan-fallback.js";

/** What the batch row stores. `null` on a session that is not a receipt read
 *  (a walk with the camera), and on receipt sessions from before this state
 *  existed, which are judged by their lines. */
export type SessionReadState = "in_flight" | "read" | "failed";

export interface ReceiptReadAttempt {
  at: string;
  outcome: "read" | "failed";
  /** The parser's failure class. */
  code?: "ai_unavailable" | "no_line_items" | "unreadable";
  /** The router's coded reason, when the AI was the reason. */
  ai?: AiFallback;
  ai_reason?: ProviderErrorReason;
  reason?: string;
}

/** The batch's `read_failure` column: the last failure, and every attempt. */
export interface ReceiptReadFailure {
  code: "ai_unavailable" | "no_line_items" | "unreadable";
  ai?: AiFallback;
  ai_reason?: ProviderErrorReason;
  reason: string;
  at: string;
  history: ReceiptReadAttempt[];
}

export interface SessionReadRow {
  read_state?: SessionReadState | null;
  read_failure?: ReceiptReadFailure | null;
  read_started_at?: string | Date | null;
  source_file_id?: string | null;
}

/** A read that started this long ago and never finished is not in flight any
 *  more; the row must not spin forever on a job that died. */
export const READ_IN_FLIGHT_MAX_MS = 5 * 60 * 1000;

export type SessionVerdict =
  /** Not a receipt read at all: a camera walk, a wedge burst. */
  | { kind: "plain" }
  /** The parser is running on the original now. */
  | { kind: "in_flight" }
  /** Read, with lines (the items say how many are still pending). */
  | { kind: "read" }
  /** Read once, and every line has been dealt with. */
  | { kind: "empty" }
  /** The read failed; the sentence says why and what to do. */
  | { kind: "failed"; failure: ReceiptReadFailure; sentence: string; retry: boolean; connect: boolean };

/** The words for a failed read: what happened and what to do about it. The
 *  router's reason decides; the parser's own reasons cover the rest. */
export function receiptReadWords(f: Pick<ReceiptReadFailure, "code" | "ai" | "ai_reason" | "reason">): { sentence: string; retry: boolean; connect: boolean } {
  if (f.code === "no_line_items") return { sentence: "Couldn't find any line items on it. Check the picture shows the whole receipt, then read it again.", retry: true, connect: false };
  if (f.code === "unreadable") return { sentence: "Couldn't read the file. Try a clearer picture or a PDF.", retry: true, connect: false };
  switch (f.ai) {
    case "no-provider":
      return { sentence: "Couldn't be read: no AI provider is connected. Connect one (Configuration → AI, or your own under Account), then read it again.", retry: false, connect: true };
    case "background":
      return { sentence: "Couldn't be read: this step ran without your personal AI. Read it again to use it.", retry: true, connect: false };
    case "not-entitled":
      return { sentence: "Couldn't be read: the AI allowance for this workspace is used up for now. Read it again later.", retry: true, connect: false };
    case "provider-error":
      switch (f.ai_reason) {
        case "invalid_key":
          return { sentence: "Couldn't be read: the AI's key is not valid. Replace the key on its connection, then read it again.", retry: false, connect: true };
        case "quota":
          return { sentence: "Couldn't be read: the AI refused for its usage limit. Read it again later.", retry: true, connect: false };
        case "model_unavailable":
          return { sentence: "Couldn't be read: the AI does not serve the model its connection names. Pick another model, then read it again.", retry: false, connect: true };
        case "unreachable":
          return { sentence: "Couldn't be read: the AI could not be reached. Read it again.", retry: true, connect: false };
        default:
          return { sentence: "Couldn't be read: the AI errored. Read it again.", retry: true, connect: false };
      }
    case "no-answer":
      return { sentence: "Couldn't be read: the AI did not answer in time. Read it again.", retry: true, connect: false };
    default:
      return { sentence: `Couldn't be read: ${f.reason || "the read failed"}. Read it again.`, retry: true, connect: false };
  }
}

/**
 * The session's verdict, from its row and its lines.
 *
 * `pendingLines` and `everLines` are the session's receipt lines: still
 * pending, and ever created (any status). A pre-state session (no read_state)
 * is read if it has lines and plain if it never had a source.
 */
export function sessionVerdict(
  row: SessionReadRow,
  lines: { pending: number; ever: number },
  now: number = Date.now(),
): SessionVerdict {
  const started = row.read_started_at ? new Date(row.read_started_at).getTime() : null;
  if (row.read_state === "in_flight") {
    if (started !== null && now - started < READ_IN_FLIGHT_MAX_MS) return { kind: "in_flight" };
    // Started and never finished: the job died. Say so rather than spin.
    const failure: ReceiptReadFailure = row.read_failure ?? { code: "unreadable", reason: "the read did not finish", at: new Date(now).toISOString(), history: [] };
    return { kind: "failed", failure, ...receiptReadWords({ ...failure, reason: "the read did not finish" }) };
  }
  if (row.read_state === "failed" && row.read_failure) {
    return { kind: "failed", failure: row.read_failure, ...receiptReadWords(row.read_failure) };
  }
  if (row.read_state === "read" || (row.read_state == null && row.source_file_id && lines.ever > 0)) {
    return lines.pending > 0 || lines.ever === 0 ? { kind: "read" } : { kind: "empty" };
  }
  return { kind: "plain" };
}

/** Does this session need a person? A failed read does; an in-flight one is
 *  the machine's turn; the rest are judged by their lines. */
export function sessionNeedsAttention(v: SessionVerdict): boolean {
  return v.kind === "failed";
}
