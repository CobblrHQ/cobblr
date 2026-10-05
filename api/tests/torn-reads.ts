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

export async function expectNeverTorn<T>(o: {
  poll: () => Promise<T>;
  torn: (answer: T) => string | null;
  settled: (answer: T) => boolean;
  during?: Promise<unknown>;
  /** Reads in flight at once each round (a page and its retries). */
  width?: number;
  maxRounds?: number;
}): Promise<T> {
  const width = o.width ?? 3;
  const maxRounds = o.maxRounds ?? 2000;
  let writing = !!o.during;
  const done = o.during?.finally(() => {
    writing = false;
  });
  const tornSeen: string[] = [];
  let last: T | undefined;
  for (let round = 0; round < maxRounds; round++) {
    const answers = await Promise.all(Array.from({ length: width }, () => o.poll()));
    for (const a of answers) {
      const why = o.torn(a);
      if (why) tornSeen.push(why);
      last = a;
    }
    if (!writing && answers.some((a) => o.settled(a))) break;
  }
  await done;
  expect(tornSeen, "an answer was torn: finished, with what it finished missing").toEqual([]);
  expect(last !== undefined && o.settled(last), "the work settled while it was polled").toBe(true);
  return last as T;
}
