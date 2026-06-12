// Fire-and-forget poke to the host-side feedback-triage analyzer. The analyzer
// (a `claude -p` daemon on the box; operator infra, source in the private cloud
// ops repo at ops/feedback-triage/) exposes a
// /triage-now endpoint; on a new feedback submission we nudge it so triage
// happens within seconds instead of waiting for its hourly catch-up sweep.
//
// No-op when COBBLR_TRIAGE_TRIGGER_URL is unset (open-core / dev) — the sweep is
// the backstop, so a missing or failed poke is never an error. Uses `||` (not
// `??`) because compose passes an unset optional var as "" (core CLAUDE.md §14.6).

const TRIGGER_URL = process.env.COBBLR_TRIAGE_TRIGGER_URL || "";

export function pokeTriage(feedbackId: string): void {
  if (!TRIGGER_URL) return;
  void (async () => {
    try {
      await fetch(TRIGGER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback_id: feedbackId }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      /* the hourly sweep covers it — a dropped poke is not a failure. */
    }
  })();
}
