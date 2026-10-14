#!/usr/bin/env tsx
// A line of facts joined with " · " is joined by MetaParts, which drops an empty part and a part already said, never by a hand-written {i > 0 && " · "}.
//
// THE BUG THIS PREVENTS. #6234 (2026-10-13): a book scan card joined its own line and said its ISBN at both ends, the scanned barcode and the book hit model number
//
// THE RULE. Outside web/src/components/MetaParts.tsx, no line writes a
// separator by its index: {i > 0 && " · "}, {i > 0 ? " · " : ...}, or a
// .join(" · ") over JSX. A plain .join(" · ") over strings that are already
// distinct (a count and a date) is not judged.
//
// THE BOUNDARY. The five lines that joined by hand on main were all
// index-guarded maps; nothing yet tested whether a string join should be held
// too, so it is not.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-meta-lines-join-through-one-door.ts   (pnpm lint meta-lines-join-through-one-door)
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
    if (file.endsWith("components/MetaParts.tsx")) break;
    if (/\bi\s*>\s*0\s*(?:&&|\?)\s*["'`] · ["'`]/.test(line)) {
      out.push({ file, line: i + 1, what: 'a separator written by its index: an empty part leaves it hanging and a repeated one is said twice' });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:meta-lines-join-through-one-door - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Render <MetaParts parts={[...]} /> (web/src/components/MetaParts.tsx) instead of mapping with \" · \"");
  process.exit(1);
}
console.log(`lint:meta-lines-join-through-one-door OK`);
