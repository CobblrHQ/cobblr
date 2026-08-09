import type { ScanInboxItem } from "../lib/api";

// Is a re-run / replay ACTUALLY in flight on the server? The run stamps
// pipeline_started_at, clears finalized_at, and re-stamps finalized_at (atomically
// with matched_at + candidates) only when the whole chain is done. So "not
// finalized yet, started recently" IS the run.
//
// This is the ONE definition of re-running, shared by the header "N finishing"
// count AND the card's AI spinner. They were two separate computations that
// disagreed for the full ~60s of a real AI re-run: the header read these
// timestamps (correct: still running) while the card tracked only its own detached
// mutation (`rerun.isPending || reading`, which cleared the instant the name
// landed), so "1 finishing" showed with no spinner (reported 2026-07-17). It lives
// here, not in ScanPage, so both the page and its test import ONE truth (and the
// no-page-imports-a-page lint stays satisfied). The 300s ceiling is the backstop
// for a run that dies without ever stamping finalized_at; the backend stamps it on
// failure too, so that's rare.
export function isRerunInFlight(it: ScanInboxItem, now = Date.now()): boolean {
  if (it.status !== "pending") return false;
  const meta = (it.suggested_metadata ?? {}) as {
    pipeline_started_at?: string;
    finalized_at?: string;
  };
  if (meta.finalized_at || !meta.pipeline_started_at) return false;
  return now - new Date(meta.pipeline_started_at).getTime() < 300_000;
}

// Is this row still being worked by the AI pipeline — i.e. NOT yet settled? The
// single source of truth behind BOTH the per-card "finishing…" spinner and the
// session-header "N finishing / all set" signal (and the inbox's fast-vs-idle
// poll), so they never diverge. Three not-done phases:
//   • serverMatching — identified but the matchmaker hasn't produced routing yet
//   • rerunning      — a re-run / replay in flight (real work: tens of seconds)
//   • awaitingFresh  — brand-new, nothing has come back at all
// Terminal states (couldn't-identify, rate-limit-gave-up) count as DONE — they
// need the user, not more AI. Lives here (not ScanPage) so page + test share ONE
// truth and the no-page-imports-a-page lint stays satisfied.
export function itemEnriching(it: ScanInboxItem, now = Date.now()): boolean {
  if (it.status !== "pending") return false;
  const meta = (it.suggested_metadata ?? {}) as {
    matched_at?: string;
    rate_limited?: boolean;
  };
  const cands = (it.suggested_candidates ?? []).length;
  const aiAgeMs = it.ai_suggested_at ? now - new Date(it.ai_suggested_at).getTime() : Infinity;
  // Enrichment finished but produced no name/candidates → it needs the USER, not
  // more AI; that's DONE-for-the-pipeline, not "finishing".
  const needsName = !it.suggested_name && !!it.ai_suggested_at && cands === 0;
  // A receipt/note line is matched WITHOUT an ai_suggested_at — its name comes
  // from the receipt parse, not the AI identify. Fall back to created_at age so it
  // still reads as "matching" while the server routes it; otherwise aiAgeMs is
  // Infinity, serverMatching is false, and the line looks DONE the instant it
  // appears: no spinner + only the slow idle poll, so an EMAILED receipt looked
  // frozen and didn't refresh live (reported 2026-07-24). matched_at ends it either way.
  const freshMs = it.created_at ? now - new Date(it.created_at).getTime() : Infinity;
  const workingAgeMs = Math.min(aiAgeMs, freshMs);
  const serverMatching =
    !!(it.suggested_name || it.ai_suggested_at) &&
    cands === 0 &&
    !meta.matched_at &&
    !needsName &&
    workingAgeMs < 180_000;
  const awaitingFresh = !it.suggested_name && !it.ai_suggested_at && cands === 0 && !meta.rate_limited;
  return isRerunInFlight(it, now) || serverMatching || awaitingFresh;
}
