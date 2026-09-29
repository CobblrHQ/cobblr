#!/usr/bin/env tsx
// A test waits for what it needs, never for a fixed number of milliseconds.
//
// THE BUG THIS PREVENTS. a-sandbox-never-offers-a-bundle-update.test.tsx
// waited 30 ms (`await new Promise((r) => setTimeout(r, 30))`) for a hook to
// settle before asserting nothing had been offered. On an idle machine 30 ms
// is plenty; on a CI box at load 50 it is not, and the test went red on
// changes that never touched it. Two sessions fixed it separately on the same
// day (2026-09-29). A fixed wait is a guess about the machine: too short and
// the test is flaky, too long and every run pays for it.
//
// THE RULE. In a test file, no wait for a literal duration:
//   - a Promise around setTimeout with a literal (`new Promise((r) =>
//     setTimeout(r, 50))`);
//   - a sleep/delay/wait/pause helper called with a literal (`sleep(200)`);
//   - the awaitable `setTimeout(100)` from node:timers/promises;
//   - a shell `sleep 1` inside a command string the test runs (a spawned
//     `bash -c "sleep 1; <change>"` orders the change by the clock: on a
//     loaded runner merge-landed.test.ts's rewind landed before the read it
//     had to follow, 2026-09-29). Order it off the event instead, e.g. by
//     wrapping the function whose call it must follow.
// Wait for the thing instead: waitFor / findBy, awaiting the query or the
// request itself, polling a condition with a deadline, or fake timers
// (vi.useFakeTimers + advanceTimersByTime), which are exact. A zero-duration
// yield (`setTimeout(r, 0)`) is a turn of the event loop, not a guess about
// the machine's speed, and passes. A genuine exception (a test OF a timeout,
// where the duration is the subject) says why on the line or the line above:
//   // fixed-wait: <reason>
//
// THE RATCHET. 166 such waits existed in 120 files when this was written (168
// in 122 once shell sleeps counted).
// scripts/test-fixed-waits-baseline.json holds each file's count; a file may
// only go down. A new file, or a file with more than its count, fails. When a
// file drops, `pnpm lint test-fixed-waits -- --update` shrinks the baseline.
//
//   pnpm lint test-fixed-waits
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoFiles } from "./lib/repo-files.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "test-fixed-waits-baseline.json");

const PATTERNS: Array<[RegExp, string]> = [
  [/new Promise\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\s*,\s*([\d_]+)\s*\)/, "a Promise around setTimeout with a fixed duration"],
  [/\b(?:sleep|delay|wait|pause)\(\s*([\d_]+)\s*\)/, "a sleep helper with a fixed duration"],
  [/\bsetTimeout\(\s*([\d_]+)\s*\)/, "timers/promises setTimeout with a fixed duration"],
  [/["'`][^"'`]*\bsleep\s+([\d.]+)(?![\w.])/, "a shell sleep in a command the test runs"],
];

/** The fixed waits on one line, or none. A zero duration is a yield, not a wait. */
function fixedWaits(line: string, above: string): string[] {
  if (/\/\/\s*fixed-wait:\s*\S/.test(line) || /\/\/\s*fixed-wait:\s*\S/.test(above)) return [];
  const found: string[] = [];
  for (const [re, what] of PATTERNS) {
    const m = re.exec(line);
    if (!m) continue;
    const ms = Number((m[2] ?? m[1] ?? "").replace(/_/g, ""));
    if (Number.isFinite(ms) && ms > 0) found.push(`${what} (${ms} ${what.includes("shell") ? "s" : "ms"})`);
  }
  return found;
}

function testFiles(): string[] {
  return repoFiles(["*.test.ts", "*.test.tsx", "*.test.mjs", "*.test.js"], ROOT).filter((f) => !f.includes("node_modules/"));
}

const counts = new Map<string, number>();
const where = new Map<string, string[]>();
for (const f of testFiles()) {
  let src: string;
  try {
    src = readFileSync(join(ROOT, f), "utf8");
  } catch {
    continue;
  }
  if (!/setTimeout|sleep|delay|wait\(|pause\(/.test(src)) continue;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hits = fixedWaits(lines[i] ?? "", lines[i - 1] ?? "");
    if (!hits.length) continue;
    counts.set(f, (counts.get(f) ?? 0) + hits.length);
    where.set(f, [...(where.get(f) ?? []), ...hits.map((h) => `${f}:${i + 1}  ${h}`)]);
  }
}

if (process.argv.includes("--update")) {
  const next = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`lint:test-fixed-waits: baseline written, ${counts.size} file(s), ${[...counts.values()].reduce((a, b) => a + b, 0)} wait(s)`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
const over: string[] = [];
for (const [f, n] of counts) {
  const allowed = baseline[f] ?? 0;
  if (n > allowed) over.push(...(where.get(f) ?? []), allowed ? `    (${f} is allowed ${allowed}, has ${n})` : "");
}
const shrunk = Object.entries(baseline).filter(([f, n]) => (counts.get(f) ?? 0) < n).map(([f]) => f);

if (over.length) {
  console.error("lint:test-fixed-waits - a test waits a fixed number of milliseconds:");
  for (const o of over.filter(Boolean)) console.error(`  ${o}`);
  console.error(
    "\nA fixed wait is a guess about the machine: flaky on a loaded CI box, slow everywhere else.\n" +
      "Wait for the thing: waitFor / findBy, await the query or request, poll a condition with a\n" +
      "deadline, or use fake timers. A test OF a timeout says why: `// fixed-wait: <reason>`.",
  );
  process.exit(1);
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`lint:test-fixed-waits OK (${total} fixed wait(s) in ${counts.size} file(s), none new)${shrunk.length ? `; ${shrunk.length} file(s) dropped below their count: run with --update to shrink the baseline` : ""}`);
