// What the connection pools look like right now, and the one log line a
// starved pool owes the person reading the log.
//
// The api hung on the dev rig for sixteen minutes with the database healthy
// and the event loop alive, and nothing said why: every meta client was
// checked out and never returned, every later checkout waited in silence,
// and the only signal was the container's health probe timing out (#3033).
// pg-pool knows the three numbers that tell that story (clients open, idle,
// and callers waiting for one); nothing read them. /healthz reports them now,
// and a watch logs once when callers have been waiting for longer than a
// query should take, and once more when the wait clears, so the log names a
// starving pool while it is starving rather than after a restart.
import type { Pool } from "pg";

export interface PoolCounts {
  /** Clients the pool has open, idle or borrowed. */
  total: number;
  idle: number;
  /** Callers waiting for a client: the number that should be zero. */
  waiting: number;
}

export function poolCounts(pool: Pool): PoolCounts {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

export interface StarvationState {
  /** When callers were first seen waiting in the current stretch, or null. */
  waitingSince: number | null;
  /** The stretch has been reported already. */
  reported: boolean;
}

export const STARVED_AFTER_MS = 10_000;

/** The pure decision behind the watch: given the last state and a fresh
 *  sample, the next state and the line to log (or none). A stretch of
 *  waiting is reported once it has lasted `afterMs`, and its end is reported
 *  once, so a pool that starves for a minute costs two lines, not twelve. */
export function starvationStep(
  state: StarvationState,
  sample: PoolCounts,
  now: number,
  afterMs: number = STARVED_AFTER_MS,
): { state: StarvationState; line: string | null } {
  if (sample.waiting > 0) {
    const since = state.waitingSince ?? now;
    if (!state.reported && now - since >= afterMs) {
      return {
        state: { waitingSince: since, reported: true },
        line: `starved: ${sample.waiting} waiting for ${Math.round((now - since) / 1000)}s (${sample.total} open, ${sample.idle} idle); nothing that holds a client is giving it back`,
      };
    }
    return { state: { waitingSince: since, reported: state.reported }, line: null };
  }
  if (state.reported) {
    return { state: { waitingSince: null, reported: false }, line: `recovered: nobody waiting (${sample.total} open, ${sample.idle} idle)` };
  }
  return { state: { waitingSince: null, reported: false }, line: null };
}

/** Sample a pool every `everyMs` and log the two lines above under `label`.
 *  The timer is unref'd, so it never keeps a process alive. Returns a stop. */
export function startPoolWatch(
  label: string,
  read: () => PoolCounts,
  everyMs = 5_000,
  holders?: () => string[],
): () => void {
  let state: StarvationState = { waitingSince: null, reported: false };
  // SINGLE-PROCESS-SAFE: reads this process's own pool counters and writes
  // this process's own log; another api against the same database has its
  // own pools and its own line to write.
  const t = setInterval(() => {
    const next = starvationStep(state, read(), Date.now());
    state = next.state;
    if (next.line) console.error(`[${label}] ${next.line}`);
    // A starved pool names who holds it, so the next wedge is diagnosed from
    // the log (poolHolders, #3666).
    if (next.line?.startsWith("starved") && holders) {
      const held = holders();
      for (const h of held.slice(0, 12)) console.error(`[${label}]   ${h}`);
      if (held.length > 12) console.error(`[${label}]   ...and ${held.length - 12} more`);
    }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** Check out `n` clients and hold them. If ANY checkout fails, every client
 *  already taken goes back at once and the failure is thrown. A bare
 *  `Promise.all` over `pool.connect()` strands the clients it did get when one
 *  times out, because the caller never sees them: that is how a CI run's meta
 *  pool wedged for good, every later request waiting on ten clients nobody
 *  held a reference to (#3666). `lint:no-promise-all-over-connect` refuses the
 *  bare form. */
export async function holdClients<C extends { release: () => void }>(
  pool: { connect: () => Promise<C> },
  n: number,
): Promise<C[]> {
  const settled = await Promise.allSettled(Array.from({ length: n }, () => pool.connect()));
  const held = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) {
    for (const c of held) c.release();
    throw failed.reason;
  }
  return held;
}
