// A test-support sweep round that found a pass BUSY is asked again; one that found a pass FAILED is not.
//
// The kernel walks every workspace for every pass on one tick, and each pass holds an advisory lock
// for the length of its walk. A test that asks for one workspace's round while that walk is going
// is told the pass was skipped, which the round answers as 500. That is the scheduler being in the
// way for a few seconds, not a heal failing, and the test used to fail on it (#4927).
//
// A pass that FAILED, or a round with nothing to say, still ends the wait at once: waiting for
// those would hide the very thing the round is there to report.

/** @typedef {{ status: number, body: { passes: number, failed: Array<{ name: string, skipped: boolean, failures: unknown[] }> } }} RoundAnswer */

/** Only passes that sat the round out, none failing: a busy answer. */
export function onlyBusy(body) {
  return body.failed.length > 0 && body.failed.every((p) => p.skipped && p.failures.length === 0);
}

/**
 * @param {() => Promise<RoundAnswer>} ask one round for the workspace
 * @param {{ deadlineMs: number, gapMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number }} opts
 * @returns {Promise<RoundAnswer["body"]>}
 */
export async function settledSweepRound(ask, opts) {
  const gap = opts.gapMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + opts.deadlineMs;
  for (;;) {
    const { status, body } = await ask();
    if (status === 200) return body;
    if (!onlyBusy(body)) throw new Error(`a sweep failed: ${JSON.stringify(body.failed).slice(0, 400)}`);
    if (now() >= until) throw new Error(`${body.failed.length} sweep(s) were still busy after ${opts.deadlineMs} ms: ${body.failed.map((p) => p.name).join(", ")}`);
    await sleep(gap);
  }
}
