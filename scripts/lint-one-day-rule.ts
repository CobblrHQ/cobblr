#!/usr/bin/env tsx
// A claim about what day it is comes from the platform's day rule, never from the UTC day: new Date().toISOString().slice(0, 10) is tomorrow all evening in the Americas.
//
// THE BUG THIS PREVENTS. the expiry digest said 'expires today' the evening before, a restocked lot was dated tomorrow and counted its shelf life from tomorrow, and a maintenance form pre-filled a day nobody had reached (#3351, 2026-09-22)
//
// THE RULE. `new Date().toISOString().slice(0, 10)` (and the same shape over
// `Date.now()`) is the UTC day, which is nobody's day: west of Greenwich it is
// already tomorrow through the whole evening. So it may not be the source of a
// day a person is shown or a record is dated with. Use the rule instead
// (`@cobblr/platform-contract/day`):
//
//   dayIn(now, zone)              the person's day, when their zone is known
//   platform().accounts.dayFor()  the same, for code that has their id
//   arrivedEverywhere(now)        one message for many people: never early
//   dayHere(now)                  in the browser, the local calendar day
//
// WHAT STILL PASSES: a STAMP that is not a claim about anybody's calendar - a
// download filename, an export manifest's capture date. Those opt out on the
// line with `// UTC-DAY OK: <reason>`, and the reason is read at review.
// A date the caller already has (`someDate.toISOString().slice(0, 10)`) is not
// this shape and is not matched: the rule is about asking what day it is NOW.
//
// ALSO (2026-09-23): the same ask with an offset, `new Date(Date.now() + n *
// 86_400_000)`, and a day formatted in a zone that falls back to UTC
// (`someDay(now, zone ?? "UTC")`). The second is how inventory's lot dates
// kept the UTC day after #3351: a check-off with no zone sent stamped the day
// after the one the shopping row had just promised. And tests count: three
// api tests compared the product's day with the UTC one and turned main red
// every night from 00:00 to 12:00 UTC.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-one-day-rule.ts   (pnpm run lint:one-day-rule)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "api/tests", "modules", "web/src", "packages"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

/** Asking the clock what day it is, in UTC: `new Date()` or `Date.now()`
 *  straight into a `YYYY-MM-DD` slice. A date the caller already holds is a
 *  different thing and is not matched. */
const UTC_DAY_NOW = /new Date\(\s*(?:Date\.now\(\s*\)[^()]*)?\)\s*\.toISOString\(\s*\)\s*\.slice\(\s*0\s*,\s*10\s*\)/;
/** A day formatted in a zone that falls back to UTC when none is known. */
const UTC_ZONE_FALLBACK = /(?:[Dd]ay|[Tt]oday|DateTimeFormat)\w*\([^;]*\?\?\s*["']UTC["']/;
/** The opt-out, on the offending line or the one above it. */
const ALLOWED = /\/\/ UTC-DAY OK: \S/;
/** The rule's own file may name the shape it replaces. */
const OWNER = /packages\/platform-contract\/src\/day\.ts$/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (OWNER.test(file.replace(/\\/g, "/"))) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const now = UTC_DAY_NOW.test(line);
    const fallback = UTC_ZONE_FALLBACK.test(line);
    if (!now && !fallback) continue;
    if (ALLOWED.test(line) || ALLOWED.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: now ? "the UTC day as today (new Date().toISOString().slice(0, 10))" : "a day in a zone that falls back to UTC (?? \"UTC\"); an unknown zone takes the platform's rule, dayFor / arrivedEverywhere" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:one-day-rule - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use @cobblr/platform-contract/day: dayIn(now, zone) / platform().accounts.dayFor(userId) for a person,");
  console.error("arrivedEverywhere(now) for one message sent to many, dayHere(now) in the browser.");
  console.error("A stamp that claims nobody's calendar (a filename, an export manifest) opts out with  // UTC-DAY OK: <reason>");
  process.exit(1);
}
console.log(`lint:one-day-rule OK`);
