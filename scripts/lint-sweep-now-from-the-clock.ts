#!/usr/bin/env tsx
// An api test hands a test-support door a time that is pinned, never a written-in date and never the bare wall clock: a literal date rots on the day the calendar passes it, and the time of day the suite happens to run misses the window the code checks.
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
// THE SECOND BOMB, THE SAME DAY. The fix for the first swept at the bare wall
// clock (`new Date(Date.now() + n days)`), and the Tidy pass runs only from
// 02:00 to 05:00 in the workspace's time (tidyNightDue), so every daytime CI
// run swept outside the window and found nothing. A door's time is followed
// back through the names it is built from (timeShape): written-in is refused,
// the bare clock is refused, and one with its time of day set (setUTCHours,
// Date.UTC, a `T03:00` suffix) or a faked timer is accepted.
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

const PIN = /setUTCHours\(|setHours\(|Date\.UTC\(|T\d\d:\d\d|vi\.setSystemTime|useFakeTimers/;
const BARE = /Date\.now\(\)|new Date\(\s*\)/;
const LIT = /"20\d\d-\d\d-\d\d(T[^"]*)?"/;

/** The source a name stands for in this file: `const x = …;`, `let x = …;`,
 *  `function x(…) {…}` or `const x = (…) => …` (the line, or the block). */
function definitionOf(name: string, src: string): string | null {
  const fn = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)[^{]*\\{([^]*?)\\n\\}`).exec(src);
  if (fn) return fn[1] ?? "";
  const v = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*([^;\\n]*(?:\\{[^]*?\\n\\s*\\};?)?)`).exec(src);
  return v ? (v[1] ?? "") : null;
}

/** How a value given to a test door gets its time: "literal", "bare" (the wall
 *  clock at whatever time the suite runs), "pinned", or "unknown". */
export function timeShape(expr: string, src: string, depth = 0): "literal" | "bare" | "pinned" | "unknown" {
  if (LIT.test(expr)) return "literal";
  if (PIN.test(expr)) return "pinned";
  if (BARE.test(expr)) return "bare";
  if (depth > 3) return "unknown";
  for (const m of expr.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const name = m[1]!;
    if (["new", "Date", "toISOString", "getTime", "Number", "String", "now", "await"].includes(name) && name !== "now") continue;
    const def = definitionOf(name, src);
    if (def === null) continue;
    const shape = timeShape(def, src, depth + 1);
    if (shape !== "unknown") return shape;
  }
  return "unknown";
}

export function check(file: string, src: string): Violation[] {
  if (!src.includes("test-support/")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  // helpers whose body posts to a test door and forward a parameter as its time
  const helpers = new Set<string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*async\s*\((\w+)[^)]*\)\s*=>\s*\{[^]*?test-support\/[^]*?(?:now|at|today|day):\s*\2\b/g)) {
    if (m[1]) helpers.add(m[1]);
  }
  const judge = (i: number, expr: string, via: string) => {
    const shape = timeShape(expr, src);
    if (shape === "literal") out.push({ file, line: i + 1, what: `${via} a written-in date: build it from the clock, pinned inside the window the code checks` });
    if (shape === "bare") out.push({ file, line: i + 1, what: `${via} the bare wall clock: pin the time of day (setUTCHours) inside every window the code checks, or fake the timer` });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/sweep-now: \S/.test(line) || /sweep-now: \S/.test(lines[i - 1] ?? "")) continue;
    // a door's body on this line or the next few: `now: <expr>`
    if (/test-support\//.test(line)) {
      const block = lines.slice(i, i + 6).join(" ");
      const m = /\b(?:now|at|today|day)"?:\s*([^,}]+)/.exec(block);
      if (m && !helpers.size) judge(i, m[1]!.trim(), "a test door given");
      else if (m && !new RegExp(`\\b(?:now|at|today|day)"?:\\s*(${[...helpers].join("|")})?\\b`).test(block)) judge(i, m[1]!.trim(), "a test door given");
    }
    for (const h of helpers) {
      const call = new RegExp(`\\b${h}\\(([^)]*)\\)`).exec(line);
      if (call && !/=>/.test(line)) judge(i, call[1] ?? "", `${h}() is handed`);
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
