// Is this workspace a no-account sandbox whose hour is up? The decision, with
// no clock or database in it, so the tenant middleware and a test agree.
//
// Past `trial_expires_at` a sandbox is frozen: every tenant route answers 410
// sandbox_expired from that moment, not from whenever the reaper gets to it.
// Since #3254 the reaper deletes it a decision window later (see
// TRY_SANDBOX_DECISION_HOURS), so the ending page can still keep it; keeping
// is not a workspace route and is not stopped here.
//
// A kept workspace (sandbox = false) is a trial with a length the person chose
// (a week, two weeks, a month) and the bound is the product: on the box that
// hands out sandboxes, a trial past its end is refused at the door too, with
// its own answer (410 trial_expired) so it never reads as a deleted sandbox.
// The reaper's humane warn → grace → delete path still runs behind it; a
// cleanup is not an access control, and a trial that only ends when a sweep
// happens to run is a trial that sometimes does not. Elsewhere (prod,
// staging, self-host) trial_expires_at is also stamped by the trial tier, and
// this rule is never applied there: the caller gates it on sandboxEnabled().

export function sandboxIsOver(
  row: { sandbox: boolean; trial_expires_at: Date | null },
  now: number = Date.now(),
): boolean {
  return row.sandbox && row.trial_expires_at !== null && row.trial_expires_at.getTime() <= now;
}

export function trialIsOver(
  row: { sandbox: boolean; trial_expires_at: Date | null },
  now: number = Date.now(),
): boolean {
  return !row.sandbox && row.trial_expires_at !== null && row.trial_expires_at.getTime() <= now;
}
