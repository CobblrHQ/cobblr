#!/usr/bin/env tsx
// A date-only value is a calendar day, never an instant: read it with fieldDay and show it with dayLabel, never through new Date().
//
// THE BUG THIS PREVENTS. A service visit scheduled for the 16th read "due 10/15"
// on its record in New York (#5759, 2026-10-11). `new Date("2026-10-16")` is
// midnight UTC, which is the evening of the 15th everywhere west of Greenwich,
// so a day shown through a Date moves back one. East of Greenwich the mirror
// image: a Postgres `date` used to arrive as a Date at the SERVER's midnight and
// `.toISOString().slice(0, 10)` moved it to the day before. Every reader
// invented its own repair (`T12:00:00`, `timeZone: "UTC"`, a local-midnight
// helper), and the ones that did not were a day out.
//
// THE RULE. A `date` column now arrives as its `YYYY-MM-DD` text
// (api/src/db/client-error-guard.ts), and a day stays a string:
//
//   fieldDay(value)            the day a stored value names (the one parse)
//   dayLabel(day, opts)        the day in words, the same day in every zone
//   daysUntil(day, today)      the countdown, day against day
//   instantOnDay(day, zone)    the instant to store when a column is an instant
//
// So this refuses, in shipping code:
//   - `new Date(x)` / `Date.parse(x)` where x is a date-only value: a column
//     whose SQL type is `date` (DISCOVERED from the migrations, so a new date
//     column is covered the day it lands) or a variable named as a day;
//   - `new Date("2026-10-16")`, a date-only literal;
//   - `<date-only>.toISOString().slice(0, 10)` and `.toLocaleDateString()`
//     straight on one.
// A line that genuinely means the instant opts out with `// DAY-OK: <reason>`
// on it or the line above, and the reason is read at review.
//
// PROVE IT RED before you trust it green: on the merge-base of #5759 it names
// the maintenance and project readers that showed a day early.
//
//   node scripts/lint-date-only-is-a-day.ts   (pnpm run lint date-only-is-a-day)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOTS = ["api/src", "modules", "web/src", "packages"];
const MIGRATION_ROOTS = ["api/migrations", "modules"];

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** Files under `roots` (tracked or new, never ignored) that git says match
 *  `pattern`: the tree is searched by git once, and only candidates are
 *  opened here. */
function candidates(roots: string[], globs: string[], pattern: string): string[] {
  const args = ["grep", "--untracked", "-l", "-E", pattern, "--", ...roots.flatMap((r) => globs.map((g) => `${r}/${g}`))];
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean);
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

/** Every column whose SQL type is `date`, read from the migrations. */
function dateColumns(sqlFiles: Iterable<string>, read: (f: string) => string = (f) => readFileSync(f, "utf8")): Set<string> {
  const out = new Set<string>();
  const declared = /(?:^|[\s,(])"?([a-z_][a-z0-9_]*)"?\s+date\b(?!\s*\()/gim;
  const altered = /alter\s+column\s+"?([a-z_][a-z0-9_]*)"?\s+(?:set\s+data\s+)?type\s+date\b/gim;
  for (const f of sqlFiles) {
    const sql = read(f).replace(/--.*$/gm, "");
    for (const m of sql.matchAll(declared)) if (!/^(type|as|column|current|default|and|or|on)$/i.test(m[1]!)) out.add(m[1]!.toLowerCase());
    for (const m of sql.matchAll(altered)) out.add(m[1]!.toLowerCase());
  }
  return out;
}

/** Variables that are a day by name, whatever table they came from. */
const DAY_NAMES = new Set(["day", "ymd", "isoDay", "dateOnly", "date_only"]);

/** The argument of a call that starts at `open` (the index of its `(`). */
function argAt(line: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return line.slice(open + 1, i);
  }
  return null;
}

/** The value an argument names: its last member, past `!`, `?? x` and `|| x`. */
function named(arg: string): string | null {
  const head = arg.split(/\?\?|\|\||,/)[0]!.trim().replace(/!$/, "");
  const m = /(?:^|[.?\s])([A-Za-z_$][\w$]*)$/.exec(head);
  return m ? m[1]! : null;
}

const ALLOWED = /\/\/ DAY-OK: \S/;
const OWNERS = /packages\/platform-contract\/src\/(day|field-day)\.ts$/;
/** A value straight off a request: a form's date input sends a bare day. */
const REQUEST_INPUT = /^(?:parsed\.data|req\.body|body|args|input|data)(?:\?)?\.[\w$]+!?$/;
const DAY_LITERAL =/^\s*["'`]\d{4}-\d{2}-\d{2}["'`]\s*$/;

function check(file: string, src: string, columns: Set<string>): Violation[] {
  if (OWNERS.test(file.replace(/\\/g, "/"))) return [];
  const isDay = (name: string | null) => !!name && (columns.has(name) || DAY_NAMES.has(name));
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("Date") || /^\s*(\/\/|\/?\*)/.test(line)) continue;
    if (ALLOWED.test(line) || ALLOWED.test(lines[i - 1] ?? "")) continue;
    for (const m of line.matchAll(/\bnew Date\(|\bDate\.parse\(/g)) {
      const arg = argAt(line, m.index! + m[0].length - 1);
      if (arg == null || !arg.trim()) continue;
      if (DAY_LITERAL.test(arg)) out.push({ file, line: i + 1, what: `${m[0]}"YYYY-MM-DD") is midnight UTC, the day before west of Greenwich` });
      else if (isDay(named(arg))) out.push({ file, line: i + 1, what: `${m[0]}${named(arg)}) turns a calendar day into an instant` });
      else if (REQUEST_INPUT.test(arg.split(/\?\?|\|\|/)[0]!.trim())) out.push({ file, line: i + 1, what: `${m[0]}${arg.trim()}) reads request input that may be a bare day as midnight UTC; use instantFromInput` });
    }
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\)?!?\??\.(toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)|toLocaleDateString\()/g)) {
      if (isDay(m[1]!)) out.push({ file, line: i + 1, what: `${m[1]}.${m[2]!.startsWith("toISO") ? "toISOString().slice(0, 10)" : "toLocaleDateString()"} reads a day through an instant` });
    }
  }
  return out;
}

{
  const columns = dateColumns(candidates(MIGRATION_ROOTS, ["*.sql"], "\\bdate\\b"));
  const violations: Violation[] = [];
  for (const file of candidates(ROOTS, ["*.ts", "*.tsx"], "new Date\\(|Date\\.parse\\(|toISOString\\(\\)|toLocaleDateString")) {
    if (/\.(test|spec)\.tsx?$/.test(file) || /\/tests?\//.test(file) || /\/(node_modules|dist)\//.test(file)) continue;
    violations.push(...check(file, readFileSync(file, "utf8"), columns));
  }
  if (violations.length) {
    console.error(`lint:date-only-is-a-day - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A day is a string. Use @cobblr/platform-contract/day: fieldDay(value) to read one, dayLabel(day) to show one,");
    console.error("daysUntil(day, today) to count to one, instantOnDay(day, zone) to store one in an instant column.");
    console.error("A line that genuinely means the instant opts out with  // DAY-OK: <reason>");
    process.exit(1);
  }
  console.log(`lint:date-only-is-a-day OK (${columns.size} date columns)`);
}
