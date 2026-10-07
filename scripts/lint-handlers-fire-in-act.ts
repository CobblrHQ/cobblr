#!/usr/bin/env tsx
// A component test fires a handler or resolver it captured from a stub inside act(), never bare.
//
// THE BUG THIS PREVENTS. main red at fdf17684e, run 37813: a bare NFC onreading left the stop unrendered when the next line looked
//
// The test called the reader's onreading itself; the handler stopped the scan
// with a state update, waitFor passed on a callback that had already run,
// and on a loaded runner the next line read the screen before React drew it.
// React logs nothing for this (0 act warnings across 623 web test files,
// including that one), so no console guard can see it; the source can.
//
// THE RULE. In a test file, a function the test captured into a typed `let`
// (`let reading!: (event) => void`, `let release: (() => void) | null`), from a
// stub's setter, a mocked hook or a deferred promise, is called inside act():
// `act(() => reading(event))`, `await act(async () => release())`. A bare
// statement-level call fails. A genuine exception says why on the line:
// `// OUTSIDE-ACT: <reason>`.
//
// THE BOUNDARY. Only a `let` with a function type: a test's own helpers are
// `const` functions and run nothing of React's. A call inside an act()
// callback on another line is not seen as bare, because only a statement
// that starts with the name is judged; an act block's body starting with it
// is the one place this would misfire, so wrap it on one line or annotate.
// The near-miss that drew it: a harness component's `.then((r) =>` with the
// setter on the next line is a callback's body, not a statement the test
// runs (undo-from-the-filed-row-returns-it-to-the-inbox), so a line whose
// previous line ends in `=>` is not judged.
//
// Proved red on the seven files that did it when it was written (10 calls).
//
//   npx tsx scripts/lint-handlers-fire-in-act.ts   (pnpm lint handlers-fire-in-act)
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
    else if (/\.test\.tsx$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const captured = new Set<string>();
  for (const m of src.matchAll(/^\s*let (\w+)!?:\s*\(\(?[^=;]*=>/gm)) captured.add(m[1]!);
  if (!captured.size) return out;
  const lines = src.split("\n");
  const insideAct = (i: number) => {
    // The statement is the body of an act( opened on an earlier line.
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) if (/\bact\(\s*(async\s*)?\(\)\s*=>\s*\{?\s*$/.test(lines[j] ?? "")) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^\s*(?:await\s+)?(\w+)!?\(/.exec(line);
    if (!m || !captured.has(m[1]!) || /\/\/ OUTSIDE-ACT: \S/.test(line) || insideAct(i)) continue;
    let prev = i - 1;
    while (prev >= 0 && /^\s*(\/\/.*)?$/.test(lines[prev] ?? "")) prev--;
    if (/=>\s*$/.test(lines[prev] ?? "")) continue;
    out.push({ file, line: i + 1, what: `${m[1]}() is a captured handler fired outside act()` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:handlers-fire-in-act - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("wrap the call: act(() => handler(event)), or await act(async () => resolve(value))");
  process.exit(1);
}
console.log(`lint:handlers-fire-in-act OK`);
