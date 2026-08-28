#!/usr/bin/env tsx
// Every repeating background loop says whether it may run in more than one
// process — because it will.
//
// THE BUG THIS PREVENTS. A periodic loop is started by every api process. For
// most of this platform's life that was one process, so nobody had to think
// about it. It is not one process any more: the canary channel runs a second
// api against the SAME database (design-decisions/canary-channel.md), and a
// rolling deploy runs two for a while. Every side-effecting loop then does its
// work twice on real user data.
//
// It surfaced as a workspace's printer posting its progress to Discord twice,
// every time, for weeks (2026-08-29) — and the same doubling was running
// through the cadence, expiry, arrival, burn-rate, maintenance and receipt
// sweepers, none of which had a guard. One of them had it right
// (delivery-sweeper, audit B4c), which is what the fix was copied from.
//
// THE RULE. A file that starts a repeating timer in server code must, for each
// timer, either:
//
//   1. run the work through the exclusive seam — `platform().exclusive.run(…)`
//      in a module, `runExclusive(…)` in the kernel; or
//   2. be claim-based — the work pulls what it acts on with
//      `for update skip locked` (the queue), so a second process finds nothing;
//   3. carry `// SINGLE-PROCESS-SAFE: <why>` in the comment above the timer —
//      a keepalive on one response, an in-memory eviction, an idempotent
//      delete. The reason is for the next reader.
//
// Anything else fails. The judgement belongs at the timer, where the person
// writing it knows the answer, not in a doc nobody opens.
//
//   cd <repo> && npx tsx scripts/lint-background-loops.ts

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["api/src", "modules"];
/** Where a repeating timer is a UI/dev concern, not a server background job. */
const SKIP = /(\/ui\/|\.test\.|\.spec\.|\/dist\/|\/node_modules\/|\/web\/)/;
const MARKER = "SINGLE-PROCESS-SAFE:";
// Generous enough for a real explanation to sit above the timer it explains
// (the reason is usually several lines), tight enough that it has to be THAT
// timer's comment rather than something further up the file.
const LOOKBACK = 12;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(`/${p}/`)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const findings: string[] = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("setInterval")) continue;
    const lines = src.split("\n");
    // A file-level guard covers every timer in it: these files are small and
    // single-purpose, and the sweepers all funnel through one tick.
    const guarded =
      src.includes("platform().exclusive.run(") ||
      src.includes("runExclusive(") ||
      src.includes("for update skip locked");
    lines.forEach((line, i) => {
      if (!/\bsetInterval\s*\(/.test(line)) return;
      // Not a real timer: a mention in prose, or code inside a generated string.
      const before = line.slice(0, line.indexOf("setInterval"));
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || /['"`]\s*$/.test(before)) return;
      if (guarded) return;
      const near = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
      if (near.includes(MARKER)) return;
      findings.push(`  ${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
}

if (findings.length) {
  console.error(
    `✗ background-loops lint: ${findings.length} repeating timer(s) with no answer to ` +
      `"what happens when two api processes run this?"\n`,
  );
  console.error(findings.join("\n"));
  console.error(
    "\nEvery api process starts these, and more than one api runs against a single\n" +
      "database (the canary channel; a rolling deploy). Pick one:\n" +
      "  · route the work through platform().exclusive.run(\"<name>\", …)  (modules)\n" +
      "    or runExclusive(\"<name>\", …)                                  (kernel)\n" +
      "  · claim what it acts on (for update skip locked), so the loser finds nothing\n" +
      "  · annotate `// SINGLE-PROCESS-SAFE: <why>` above the timer when it genuinely\n" +
      "    cannot double-act (a per-response keepalive, in-memory eviction, an\n" +
      "    idempotent delete).\n",
  );
  process.exit(1);
}
console.log("lint:background-loops ✓ every repeating timer says how it behaves with two api processes.");
