#!/usr/bin/env tsx
// Every corner FloatingChrome declares its place in the corner's stack (stack={CORNER_STACK.<name>}), so no floating control can sit on another.
//
// THE BUG THIS PREVENTS. The Live pill sat on the feedback bubble on a phone: each corner piece knew only its own lift (#4390, 2026-10-01)
//
// THE RULE. A <FloatingChrome anchor="corner"> names its place in its
// corner's stack: stack={CORNER_STACK.<name>}. The dock stacks the pieces on
// one side in that order (bottom-dock.ts stackCorner), so two can never sit
// on each other, and a new piece has to say where it goes by adding its name
// to the one list. A hand `lift` meant to clear another piece ("4.75rem, above
// the bubble") is exactly what this replaces; a lift for the piece's own
// breath is still fine.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only corner pieces: a bar
// (anchor="top" / "bottom") already stacks in the dock by registration. The
// FloatingChrome primitive itself and its tests are not pieces. Nothing has
// tested the boundary further yet.
//
//   npx tsx scripts/lint-corner-chrome-stacks.ts   (pnpm lint corner-chrome-stacks)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages", "modules"];

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
  if (file.endsWith("FloatingChrome.tsx")) return out;
  const re = /<FloatingChrome\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // The opening tag: up to the first ">" outside a {…} expression.
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && src[i - 1] !== "=") {
        end = i;
        break;
      }
    }
    const tag = src.slice(m.index, end);
    if (!/\banchor="corner"/.test(tag)) continue;
    if (/\bstack=\{/.test(tag)) continue;
    out.push({ file, line: src.slice(0, m.index).split("\n").length, what: "a corner FloatingChrome with no stack={CORNER_STACK.<name>}" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:corner-chrome-stacks - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Add stack={CORNER_STACK.<name>} (a new name goes in bottom-dock.ts CORNER_STACK, in its order)");
  process.exit(1);
}
console.log(`lint:corner-chrome-stacks OK`);
