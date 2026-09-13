// The receipt session's read state, written by /scan/receipt and its
// /reparse and read by the platform contract's sessionVerdict (scan-session.ts).
// The failure carries the router's coded reason and every attempt, so a row
// can say what happened and what to do, and a person can see the history.
import type { ReceiptReadAttempt, ReceiptReadFailure } from "@cobblr/platform-contract/scan-session";
import type { ReceiptResult } from "./receipt-shared.js";

type Failed = Extract<ReceiptResult, { ok: false }>;

/** The attempts recorded on a batch's `read_failure`, or none. */
export function readFailureHistory(stored: unknown): ReceiptReadAttempt[] {
  const h = (stored as { history?: unknown } | null)?.history;
  return Array.isArray(h) ? (h as ReceiptReadAttempt[]) : [];
}

/** A failed read, as the batch stores it: this failure on top of the history. */
export function readFailureFrom(result: Failed, prior: ReceiptReadAttempt[], at: Date = new Date()): ReceiptReadFailure {
  const attempt: ReceiptReadAttempt = {
    at: at.toISOString(),
    outcome: "failed",
    code: result.code,
    ...(result.ai ? { ai: result.ai } : {}),
    ...(result.ai_reason ? { ai_reason: result.ai_reason } : {}),
    reason: result.reason,
  };
  return {
    code: result.code,
    ...(result.ai ? { ai: result.ai } : {}),
    ...(result.ai_reason ? { ai_reason: result.ai_reason } : {}),
    reason: result.reason,
    at: attempt.at,
    history: [...prior, attempt].slice(-20),
  };
}

/** After a successful read: the history keeps the failures that were, plus
 *  this read; null when there never was a failure to remember. */
export function readHistoryAfterSuccess(stored: unknown, at: Date = new Date()): ReceiptReadFailure | null {
  const prior = readFailureHistory(stored);
  if (!prior.length) return null;
  const last = [...prior].reverse().find((a) => a.outcome === "failed");
  return {
    code: last?.code ?? "unreadable",
    ...(last?.ai ? { ai: last.ai } : {}),
    ...(last?.ai_reason ? { ai_reason: last.ai_reason } : {}),
    reason: last?.reason ?? "",
    at: last?.at ?? at.toISOString(),
    history: [...prior, { at: at.toISOString(), outcome: "read" as const }].slice(-20),
  };
}
