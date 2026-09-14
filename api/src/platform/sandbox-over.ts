// Is this workspace a no-account sandbox whose hour is up? The decision, with
// no clock or database in it, so the tenant middleware and a test agree.
//
// A sandbox is deleted at expiry by design (the reaper sweeps every few
// minutes), so past `trial_expires_at` there is nothing to keep serving:
// every tenant route answers 410 sandbox_expired from that moment, not from
// whenever the reaper gets to it. A kept workspace (sandbox = false) is an
// account trial and is NOT stopped here: its expiry is the reaper's humane
// warn → grace → delete path, and refusing it at the door would strand
// somebody the day their trial ends.

export function sandboxIsOver(
  row: { sandbox: boolean; trial_expires_at: Date | null },
  now: number = Date.now(),
): boolean {
  return row.sandbox && row.trial_expires_at !== null && row.trial_expires_at.getTime() <= now;
}
