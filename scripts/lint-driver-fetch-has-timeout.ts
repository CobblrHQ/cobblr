#!/usr/bin/env tsx
// Every fetch a printer driver makes carries a timeout signal, so a manager that stops answering fails the request instead of hanging the poll.
//
// THE BUG THIS PREVENTS. FDM Monster requests had no timeout: a manager that stopped answering hung the job poll indefinitely (farm audit, 2026-09-29)
//
// THE RULE. Every call to the global `fetch(` in a printer driver
// (modules/digifab/src/drivers, tests excepted) passes a `signal` in its
// options: requestSignal() for a read or a command, uploadSignal() for a
// file. A call that deliberately has none says `// NO-TIMEOUT-OK: <why>` on
// the line above.
//
// THE BOUNDARY. Only the drivers: they are what the poll worker waits on. A
// `.fetch(` method on some other object is not the global and is not checked.
// A comment that mentions "fetch (" is prose, not a call: ssrf.ts's
// "resolve-then-fetch (the driver re-resolves" was the first false positive.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-driver-fetch-has-timeout.ts   (pnpm lint driver-fetch-has-timeout)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/digifab/src/drivers"];

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
/** The text of a call from its opening bracket to the matching close. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /(^|[^.\w])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const line = src.slice(0, m.index).split("\n").length;
    const here = (src.split("\n")[line - 1] ?? "").trim();
    // Prose about fetching, in a comment, is not a call.
    if (here.startsWith("//") || here.startsWith("*") || here.startsWith("/*")) continue;
    if (/\bsignal\s*:/.test(callText(src, open))) continue;
    const above = src.split("\n")[line - 2] ?? "";
    if (/\/\/ NO-TIMEOUT-OK: \S/.test(above)) continue;
    out.push({ file, line, what: "fetch() with no timeout signal" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:driver-fetch-has-timeout - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("pass signal: requestSignal() or uploadSignal() from drivers/timeouts.ts");
  process.exit(1);
}
console.log(`lint:driver-fetch-has-timeout OK`);
