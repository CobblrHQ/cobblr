// Each attempt's own time for a test vitest retries (#7183). vitest keeps a retried test's attempt count and its
// total time only, so a test that timed out at 30 s and then passed in 0.4 s read the same as one slow twice.
// Registered from a setupFiles file: every attempt runs beforeEach and afterEach, failed or not, and the times go in
// the test's own meta, which vitest hands to reporters (vitest-passed-on-retry-reporter.mjs writes them down).
//
//   import { timeAttempts } from "../../scripts/lib/vitest-attempt-times.mjs";
//   timeAttempts(beforeEach, afterEach);
const started = new WeakMap();

/** @param {(fn: (ctx: any) => void) => void} beforeEach @param {(fn: (ctx: any) => void) => void} afterEach */
export function timeAttempts(beforeEach, afterEach) {
  beforeEach((ctx) => {
    started.set(ctx.task, performance.now());
  });
  afterEach((ctx) => {
    const t0 = started.get(ctx.task);
    if (t0 === undefined) return;
    started.delete(ctx.task);
    const meta = ctx.task.meta ?? (ctx.task.meta = {});
    meta.attemptMs = [...(Array.isArray(meta.attemptMs) ? meta.attemptMs : []), Math.round(performance.now() - t0)];
  });
}
