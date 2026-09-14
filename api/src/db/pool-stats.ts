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
export function startPoolWatch(label: string, read: () => PoolCounts, everyMs = 5_000): () => void {
  let state: StarvationState = { waitingSince: null, reported: false };
  // SINGLE-PROCESS-SAFE: reads this process's own pool counters and writes
  // this process's own log; another api against the same database has its
  // own pools and its own line to write.
  const t = setInterval(() => {
    const next = starvationStep(state, read(), Date.now());
    state = next.state;
    if (next.line) console.error(`[${label}] ${next.line}`);
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}
