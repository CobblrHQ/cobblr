#!/usr/bin/env tsx
// An api test never hands the run-sweep test door a written-in date as its now: what the sweep judges was stamped by the real clock, so a literal date rots on the day the calendar passes it.
//
// THE BUG THIS PREVENTS. 2026-10-05, 03:00 UTC: tidy-settings swept at a
// spelled-out "2026-10-12T03:00:00Z" to see a "Not now" hold end after seven
// days. The hold was stamped with the real clock when the test ran, so once
// the test ran after 03:00 on the 5th, "the 12th at 03:00" fell minutes
// before the hold's end and the suggestion stayed hidden: red on every PR,
// green on main only because main had not run since.
//
// THE RULE. In api/tests, a body sent to any `/test-support/` door never
// carries a time (`now`, `at`, `today`, `day`) as a literal ISO date, and a
// helper that forwards its date argument into such a body is never called with
// a literal date. Build the
// date from Date.now() (`daysFromNow(n)`), so the sweep's clock and the
// stamps it judges move together.
//
// WHY NOT EVERY TEST, AND NOT BY MOVING THE CLOCK (tried 2026-10-05): unit
// tests carry about 2,000 dates within 120 days of any given day, nearly all
// legitimate (a pure function handed its `now`), so a static rule over them is
// noise. Moving the test process's clock 14 days ahead failed 11 tests in 9
// files, every one an artifact: the JS clock moved while the shell's `date`,
// git and the kernel's file times did not. The door that took a written-in
// date against a real-clock stamp is the shape both bombs had, and it is what
// this holds.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A literal date is fine where
// nothing the sweep reads came from the real clock (a fixture whose every
// timestamp the test wrote itself). Such a line says
// `sweep-now: <why the state has no real-clock stamp>`. Nothing in the tree
// needed it when this was written.
//
//   npx tsx scripts/lint-sweep-now-from-the-clock.ts   (pnpm lint sweep-now-from-the-clock)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.ts";

const LITERAL = /"20\d\d-\d\d-\d\dT[^"]*"/;

interface Violation {
  file: string;
  line: number;
  what: string;
}

export function check(file: string, src: string): Violation[] {
  if (!src.includes("test-support/")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  // helpers whose body posts to run-sweep and forward a parameter as `now`
  const helpers = new Set<string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*async\s*\((\w+)[^)]*\)\s*=>\s*\{[^]*?test-support\/[^]*?(?:now|at|today|day):\s*\2\b/g)) {
    if (m[1]) helpers.add(m[1]);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/sweep-now: \S/.test(line) || /sweep-now: \S/.test(lines[i - 1] ?? "")) continue;
    if (line.includes("test-support/") && /\b(?:now|at|today|day)"?:\s*"20\d\d-/.test(line)) {
      out.push({ file, line: i + 1, what: "a test door given a written-in date: build it from Date.now()" });
      continue;
    }
    for (const h of helpers) {
      if (new RegExp(`\\b${h}\\(\\s*"20\\d\\d-`).test(line) && LITERAL.test(line)) {
        out.push({ file, line: i + 1, what: `${h}() forwards its date to run-sweep as now; pass a date built from Date.now()` });
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = repoFiles(["api/tests"]).filter((f) => f.endsWith(".ts"));
  const violations = files.flatMap((f) => check(f, readFileSync(f, "utf8")));
  if (violations.length) {
    console.error(`lint:sweep-now-from-the-clock - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A fixture whose every timestamp the test wrote itself may opt out with `sweep-now: <why>`.");
    process.exit(1);
  }
  console.log(`lint:sweep-now-from-the-clock OK (${files.length} files)`);
}
