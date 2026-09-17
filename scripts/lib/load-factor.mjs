// How loaded is this box right now, as a multiplier a wall-clock budget can
// wear (#3150).
//
// A vitest timeout is a wall-clock budget, so it measures the runner's load
// as much as the test: five files on one evening timed out on a box at 59-72
// load on twelve cores, one at a 5 s budget, none a consistent assertion. The
// lint runner already scales its budgets by a contention factor
// (scripts/lib/lint-budget.mjs); this is the same idea read once at start,
// from /proc/loadavg, so a suite that begins on a contended box gets budgets
// that fit the box it is on instead of the idle box the numbers were written
// for. Read once because a config is read once; the retry-on-a-quiet-box
// path in ci.yml covers load that arrives after.
//
// Never below 1 (a quiet box keeps its budgets), capped at MAX so a stalled
// box cannot turn a hang into a ten-minute wait.
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

export const LOAD_FACTOR_MAX = 3;

/** Load average over the last minute, per core; null where /proc/loadavg is absent. */
export function loadPerCore() {
  try {
    const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
    const cores = Math.max(1, availableParallelism());
    return Number.isFinite(load1) ? load1 / cores : null;
  } catch {
    return null;
  }
}

/** The multiplier for a wall-clock budget: 1 on a quiet box, load-per-core
 *  when contended, never above LOAD_FACTOR_MAX. COBBLR_LOAD_FACTOR pins it
 *  (a test seam, and a way to read a quiet box's numbers on a busy one). */
export function loadFactor(perCore = loadPerCore()) {
  const pinned = Number(process.env.COBBLR_LOAD_FACTOR);
  if (Number.isFinite(pinned) && pinned > 0) return Math.min(pinned, LOAD_FACTOR_MAX);
  if (perCore === null || !Number.isFinite(perCore)) return 1;
  return Math.min(LOAD_FACTOR_MAX, Math.max(1, perCore));
}
