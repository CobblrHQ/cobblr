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
// landed), so "1 finishing" showed with no spinner (the author, 2026-07-17). It lives
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
