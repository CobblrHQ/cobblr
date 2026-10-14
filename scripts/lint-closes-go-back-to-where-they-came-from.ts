#!/usr/bin/env tsx
// A Close that leaves a record's own address goes through useCloseToOrigin (@cobblr/platform-web): back to where it was opened from, and never a page pushed on top of the record.
//
// THE BUG THIS PREVENTS. #6266 (2026-10-13): a tool opened from a floor plan's drawer closed by pushing its collection, losing the drawer, and browser Back reopened the tool
//
// THE RULE. No onClose={() => navigate(...)}: a close written as a push to a
// fixed page. It goes through useCloseToOrigin(fallback), which steps back
// when the record was opened from a page of this app and replaces the
// record's entry with the fallback when it was not.
//
// THE BOUNDARY. Inline closes only, the six on main when the rule arrived. A
// named handler that pushes (const close = () => navigate(...)) is not
// judged yet: nothing has tested how to tell it from a close that pushes on
// purpose.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-closes-go-back-to-where-they-came-from.ts   (pnpm lint closes-go-back-to-where-they-came-from)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

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
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/onClose=\{\s*\(\)\s*=>\s*navigate\(/.test(line)) {
      out.push({ file, line: i + 1, what: "a Close that pushes a page: the place it was opened from is lost, and Back opens the record again" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:closes-go-back-to-where-they-came-from - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("const close = useCloseToOrigin(<the list>); onClose={close}");
  process.exit(1);
}
console.log(`lint:closes-go-back-to-where-they-came-from OK`);
