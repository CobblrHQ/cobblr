#!/usr/bin/env tsx
// An api test never swallows the failure of a module enable or disable: it calls ensureModule, which comes back only once the workspace says the module is on or off, so a test never starts on a state its setup did not reach.
//
// THE BUG THIS PREVENTS. a field a module adds later passed only on retry: its enable was swallowed and the module was not on yet (#4922, 2026-10-05)
//
// THE RULE. In api/tests, a request to /modules/<name>/enable or /disable
// whose failure is swallowed (`.catch(() => {})`, `=> undefined`, `=> null`)
// is refused: the test then runs on whatever state the workspace happened to
// be in. ensureModule() from ./helpers.js turns it on or off and comes back
// only once the workspace says so. A call that truly may fail (a module
// another one depends on, being switched off as a courtesy) says
// `best-effort: <why>` on its line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only enable and disable:
// they set the state a test asserts on. 148 other swallowed calls exist
// (cleanup deletes, fire-and-forget pings); a swallowed delete in a teardown
// is not a test reading the wrong state, so they are out of scope here.
//
//   npx tsx scripts/lint-setup-states-what-it-sets.ts   (pnpm lint setup-states-what-it-sets)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];

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
    else if (/\.ts$/.test(name)) yield p;
  }
}

const MODULE_SWITCH = /\/modules\/[^/"'`]+\/(enable|disable)["'`]/;
const SWALLOW = /\.catch\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)/;

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!MODULE_SWITCH.test(line) || !SWALLOW.test(line)) continue;
    if (/best-effort:\s*\S/.test(line) || /best-effort:\s*\S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "a module enable/disable whose failure is swallowed: use ensureModule(), or say best-effort: <why>" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:setup-states-what-it-sets - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use ensureModule(session, name, on) from ./helpers.js, or write // best-effort: <why> on the line or the one above.");
  process.exit(1);
}
console.log(`lint:setup-states-what-it-sets OK`);
