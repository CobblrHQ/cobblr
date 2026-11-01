// How fast the after-listen migration catch-up opens workspaces (enable.ts),
// split out so its answer to a refusing server is a unit test.

/** Workspaces caught up without a refusal before one more worker may run. */
export const CALM_BEFORE_ONE_MORE = 8;

/** How many catch-up workers may run, one answer for all of them: a refusal
 *  halves it and rests every worker, doubling the rest while the server keeps
 *  refusing, and a calm stretch lets one more back in. Each worker waiting on
 *  its own refusal left the others dialling a server that had just said no
 *  (staging, 2026-11-01). */
export function catchUpPace(workers: number, pause: { first: number; cap: number }, now: () => number = Date.now) {
  let allowed = workers;
  let calm = 0;
  let wait = 0;
  let restUntil = 0;
  return {
    /** 0 when worker `index` may open a workspace now, else how long to wait. */
    restMs: (index: number): number => {
      const rest = restUntil - now();
      if (rest > 0) return rest;
      return index < allowed ? 0 : pause.first;
    },
    allowed: () => allowed,
    refused: () => {
      allowed = Math.max(1, Math.floor(allowed / 2));
      calm = 0;
      wait = Math.min(pause.cap, wait ? wait * 2 : pause.first);
      restUntil = now() + wait;
    },
    caughtUp: () => {
      if (++calm < CALM_BEFORE_ONE_MORE) return;
      calm = 0;
      wait = 0;
      allowed = Math.min(workers, allowed + 1);
    },
  };
}
