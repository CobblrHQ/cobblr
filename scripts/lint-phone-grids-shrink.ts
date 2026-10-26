#!/usr/bin/env tsx
// A grid that sets its columns only at a breakpoint names its phone column too (grid-cols-1), so a long line cannot widen the page on a phone.
//
// THE BUG THIS PREVENTS. Purchases' top vendors card made a 393 px phone 539 px wide at 200% text (#8433, 2026-10-25)
//
// THE RULE. A class list that makes a grid (`grid`) and gives it columns at
// a breakpoint (`md:grid-cols-2`) also gives it columns below that breakpoint
// (`grid-cols-1`). Without one, a phone gets the grid's implicit `auto`
// column, and an auto column is as wide as its widest unbreakable line: a
// truncated vendor name (`truncate` is nowrap) set the column, the card and
// the page wider than the phone. `grid-cols-1` is `minmax(0, 1fr)`, which
// holds the phone's width and lets the line truncate as it was written to.
// A grid that wants the auto column on purpose says why on the same line,
// `PHONE-GRID: <reason>` in a comment (`{/* PHONE-GRID: ... */}` in JSX).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. One class list on one line:
// the token `grid`, a prefixed `grid-cols-`, and no unprefixed `grid-cols-`.
// `inline-grid`, `grid-flow-col` without breakpoint columns, and a grid whose
// columns come from a style attribute are not judged. Nothing has tested the
// boundary past those yet.
//
//   npx tsx scripts/lint-phone-grids-shrink.ts   (pnpm lint phone-grids-shrink)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/(\/\/|\/\*) PHONE-GRID: \S/.test(line)) continue;
    for (const list of line.match(/["'`][^"'`]*["'`]/g) ?? []) {
      if (!/(?<![\w:-])grid(?![\w-])/.test(list) || !/[\w-]:grid-cols-/.test(list) || /(?<![\w:-])grid-cols-/.test(list)) continue;
      out.push({ file, line: i + 1, what: "a grid with columns only at a breakpoint: on a phone its auto column grows to its widest line" });
      break;
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:phone-grids-shrink - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("add grid-cols-1 beside the breakpoint's grid-cols");
  process.exit(1);
}
console.log(`lint:phone-grids-shrink OK`);
