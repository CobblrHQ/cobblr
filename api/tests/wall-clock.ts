// A wall-clock assertion measures the box as much as the code. On a runner
// that shares its CPU (three docker builds, the tracker lane and a test job on
// one 12-core box: load 17), a 5 s drain bound took 25 s and main went red on a
// commit that moved one file (#3025). The same tree was green on the PR and on
// the six runs before it.
//
// The rule: a timing bound that is missed on a loaded box is INCONCLUSIVE, not
// red and not green. The test is skipped with the load in its reason, so the
// tracker and the scorecard count it as unjudged rather than as a pass, and a
// re-run on a quiet runner is the verdict. A bound that is MET always passes
// (meeting it under load is stronger evidence, not weaker). A bound missed on
// a quiet box is a real failure and stays red. The bound itself is never
// widened to cover the box: that would hide the regression the bound exists
// to catch.
//
// Load is the host's 1-minute average from /proc/loadavg (not namespaced, so a
// job container sees the box it is on) over the host's core count, read at the
// start and at the end of the measured window; the higher reading decides.
// WALL_CLOCK_LOAD_MAX is 1.0 per core: over it the box is oversubscribed and
// every process is waiting for a core, which is what stretches a wall clock.
// The run that motivated this was at 1.48 (17.8 on 12) and crawling; a runner
// with one test job and one docker build beside it sits at 0.7-0.8 and passes;
// a quiet runner under 0.3.
//
//   const clock = wallClock();
//   await theThing();
//   clock.expectWithin(ctx, 15_000, "the delete did not wait the held query out");
//
// `lint:wall-clock-assertions` refuses a raw toBeLessThan on an elapsed time
// in api/tests, so every timing bound goes through here.
import { readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { expect } from "vitest";

/** The part of vitest's test context this needs: `ctx.skip()` (vitest 2 has no note argument). */
export interface SkippableContext {
  skip: () => void;
}

export const WALL_CLOCK_LOAD_MAX = Number(process.env.COBBLR_WALL_CLOCK_LOAD_MAX) || 1.0;   // env override exists for proving the skip path, never for CI

export interface BoxLoad {
  load1: number;
  cores: number;
  ratio: number;
}

export function boxLoad(): BoxLoad {
  let load1 = loadavg()[0] ?? 0;
  try {
    const first = readFileSync("/proc/loadavg", "utf8").split(" ")[0];
    if (first) load1 = Number(first);
  } catch {
    /* not Linux: os.loadavg() is the same number where it exists */
  }
  const cores = Math.max(1, availableParallelism());
  return { load1, cores, ratio: load1 / cores };
}

export type WallClockVerdict = "pass" | "fail" | "inconclusive";

/** The decision, pure, so it can be tested without a clock or a box. */
export function judgeWallClock(
  took: number,
  maxMs: number,
  loads: BoxLoad[],
  loadMax = WALL_CLOCK_LOAD_MAX,
): { verdict: WallClockVerdict; worst: BoxLoad } {
  const worst = loads.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  if (took < maxMs) return { verdict: "pass", worst };
  return { verdict: worst.ratio > loadMax ? "inconclusive" : "fail", worst };
}

/**
 * The same judgement on an elapsed time you measured yourself (two stamps of
 * your own, an ordering grace): the load is read now, which is the end of
 * whatever window produced it.
 */
export function expectElapsedWithin(ctx: SkippableContext, took: number, maxMs: number, why: string): void {
  const { verdict, worst } = judgeWallClock(took, maxMs, [boxLoad()]);
  if (verdict === "inconclusive") {
    console.warn(inconclusiveLine(why, took, maxMs, worst));
    ctx.skip();
  }
  expect(took, `${why} (box at load ${worst.load1.toFixed(1)} on ${worst.cores} cores)`).toBeLessThan(maxMs);
}

// vitest 2's ctx.skip() carries no note, so the reason goes to the log with a
// stable prefix the CI log reader can find; the test shows as skipped, never
// as passed.
function inconclusiveLine(why: string, took: number, maxMs: number, worst: BoxLoad): string {
  return `INCONCLUSIVE (wall clock): ${why}: ${took}ms over the ${maxMs}ms bound on a box at load ${worst.load1.toFixed(1)} on ${worst.cores} cores (${worst.ratio.toFixed(2)} per core, limit ${WALL_CLOCK_LOAD_MAX}); re-run on a quiet runner`;
}

export function wallClock() {
  const started = Date.now();
  const loads: BoxLoad[] = [boxLoad()];
  return {
    /** Milliseconds since wallClock() was called. */
    elapsed: () => Date.now() - started,
    /**
     * Assert the elapsed time is under `maxMs`. Missed on a quiet box: fails
     * with `why`. Missed on a loaded box: skips the test as INCONCLUSIVE with
     * the load in the reason.
     */
    expectWithin(ctx: SkippableContext, maxMs: number, why: string): number {
      const took = Date.now() - started;
      loads.push(boxLoad());
      const { verdict, worst } = judgeWallClock(took, maxMs, loads);
      if (verdict === "inconclusive") {
        console.warn(inconclusiveLine(why, took, maxMs, worst));
        ctx.skip();
      }
      expect(took, `${why} (box at load ${worst.load1.toFixed(1)} on ${worst.cores} cores)`).toBeLessThan(maxMs);
      return took;
    },
  };
}
