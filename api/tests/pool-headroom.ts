// What the "is not queued behind it" tests read (#8966): a workspace pool's
// worst moment, and how many of its connections the fan-out under test held
// then. A fan-out keeps two connections free, so it is judged by what it held,
// never by whether anyone waited: on CI's pool of three, a test's own setup
// writes were still finishing their after-answer work, and a timer took one,
// while the search ran, and a parts list waited behind them, not behind the
// search (#8978).
import { expect } from "vitest";
import { worn } from "../../scripts/lib/load-factor.mjs";
import { eventually } from "./eventually.js";
import type { TestSession } from "./helpers.js";
import { testSupportJson } from "./test-support.js";

export type PoolPeak = { pool_max: number; in_use: number; peak: { waiting: number; requests: string[] } | null };

const read = (s: TestSession, forget = false) => testSupportJson<PoolPeak>("tenant-pool-peak", { body: { slug: s.slug, forget } });

/** Once nothing holds a connection of the workspace's pool, its worst moment
 *  forgotten: what comes next is the test's own. */
export async function quietPool(s: TestSession): Promise<void> {
  const settled = await eventually(() => read(s), (p) => p.in_use === 0, worn(30_000));
  expect(settled.in_use, "the workspace's pool was still busy with the test's setup").toBe(0);
  await read(s, true);
}

/** The workspace pool's worst moment since quietPool. */
export const poolPeak = (s: TestSession) => read(s);

/** How many connections the requests `whose` names held at the pool's worst moment. */
export function heldBy(p: PoolPeak, whose: RegExp): number {
  return (p.peak?.requests ?? []).reduce((n, line) => {
    const m = /^(\d+) × holding: (.*)$/.exec(line);
    return m && whose.test(m[2]!) ? n + Number(m[1]) : n;
  }, 0);
}

/** A fan-out at the pool's worst moment held no more than its share: the pool
 *  less two connections, at least one. */
export function expectShareKept(p: PoolPeak, whose: RegExp, what: string): void {
  const share = Math.max(1, p.pool_max - 2);
  expect(heldBy(p, whose), `${what} held more than its share of a pool of ${p.pool_max}: ${p.peak?.requests.join("; ") ?? ""}`).toBeLessThanOrEqual(share);
}
