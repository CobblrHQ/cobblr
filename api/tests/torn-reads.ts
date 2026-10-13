// Poll an endpoint while the work behind it is being written, and fail on any
// answer that is TORN: finished state with its payload missing or partial
// (#4890). A pattern read answered "ready" with no needs, a receipt session
// "read" with no lines, a chat turn "done" with no answer, a make step "done"
// with no files: each a reader landing between two writes. The writer rule
// (lint:state-flips-last) keeps the order; this proves it from outside, the
// way an impatient page and its retries would see it. Polling a live api only
// catches a torn READER when the writer happens to land between its two reads,
// so a reader's ORDER is proven deterministically by tornInterleavings
// (@cobblr/platform-contract/torn-reads), which lands the writer at every point
// and fails on the old pattern-needs reader; the lint's reader half keeps every
// registered reader state-first or in one readSnapshot.
//
//   const last = await expectNeverTorn({
//     during: writePromise,                       // the write under test, not awaited first
//     poll: () => http(s, org(s, "/thing")),       // one read
//     torn: (a) => (a.status === "done" && a.items.length === 0 ? "done, empty" : null),
//     settled: (a) => a.status === "done",
//   });
import { expect } from "vitest";
import { worn } from "../../scripts/lib/load-factor.mjs";

export async function expectNeverTorn<T>(o: {
  poll: () => Promise<T>;
  torn: (answer: T) => string | null;
  settled: (answer: T) => boolean;
  during?: Promise<unknown>;
  /** One short line for an answer ("ready/0 needs"): a failure then names the interleaving. */
  describe?: (answer: T) => string;
  /** Reads in flight at once each round (a page and its retries). */
  width?: number;
  maxRounds?: number;
  /** Wall-clock budget for the read, separate from workspace setup. */
  timeoutMs?: number;
}): Promise<T> {
  const width = o.width ?? 3;
  const maxRounds = o.maxRounds ?? 2000;
  const timeoutMs = o.timeoutMs ?? worn(20_000);
  const until = Date.now() + timeoutMs;
  const say = o.describe ?? ((a: T) => JSON.stringify(a));
  let writing = !!o.during;
  const done = o.during?.finally(() => {
    writing = false;
  });
  const tornSeen: string[] = [];
  const trail: string[] = [];
  let settledAnswer: T | undefined;
  let hasSettled = false;
  let rounds = 0;
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const answers = await Promise.all(Array.from({ length: width }, () => o.poll()));
    answers.forEach((a, i) => {
      trail.push(`round ${round + 1} read ${i + 1}: ${say(a)}`);
      const why = o.torn(a);
      if (why) tornSeen.push(`${why} (round ${round + 1}, read ${i + 1}; the reads before it: ${trail.slice(-7, -1).join(" | ") || "none"})`);
      if (o.settled(a)) {
        settledAnswer = a;
        hasSettled = true;
      }
    });
    if (!writing && hasSettled) break;
    const remaining = until - Date.now();
    if (remaining <= 0 || rounds === maxRounds) break;
    // Each round still races three reads, but a pending round leaves the
    // shared database time for the writer and other files' requests.
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
  }
  await done;
  expect(tornSeen.length, `an answer was torn, finished with what it finished missing: ${tornSeen.join("; ")}`).toBe(0);
  expect(hasSettled, `the work never settled in ${rounds} rounds of ${width} reads (deadline ${timeoutMs} ms); the last reads: ${trail.slice(-6).join(" | ")}`).toBe(true);
  return settledAnswer as T;
}
