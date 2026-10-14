#!/usr/bin/env tsx
// A number input never turns its text into a number with Number(), parseFloat or parseInt in its own onChange; the shared NumberField (typed measures) or NumberStepper (counts) reads it, so an emptied box is never a 0.
//
// THE BUG THIS PREVENTS. A cutter screen written like the laser ones made an emptied Quantity or Blade depth 0, and a plan the server then refused (2026-10-06); fifty inputs share the pattern.
//
// THE RULE. A JSX `<input type="number" ...>` whose own element converts its text
// with `Number(`, `parseFloat(`, `parseInt(` or a unary `+e.target.value` fails:
// `Number("")` is 0, so emptying the box writes a 0 and the person cannot type a
// new value. Read it with NumberField (a measure) or NumberStepper (a count),
// which keep the text while it is typed and tell their parent only a number that
// parses. A genuine exception carries `// ALLOW-NUMBER-COERCE: <reason>` on a line
// of the element or the one above it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A <select> that converts its
// option value with Number() is fine (it cannot be empty) and is not an <input>, so
// it is out of scope. The shared components themselves are not product callers.
//
// PROVE IT RED before you trust it green: run against main it names every input
// that converted with Number().
//
//   npx tsx scripts/lint-no-number-coercion-of-an-input.ts   (pnpm lint no-number-coercion-of-an-input)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  if (/\/(NumberField|NumberStepper|TypeableNumber)\.tsx$/.test(file)) return out;
  const lines = src.split("\n");
  for (const m of src.matchAll(/<input\b/g)) {
    const end = src.indexOf("/>", m.index!);
    const el = src.slice(m.index!, end < 0 ? m.index! + 800 : end + 2);
    if (!/\btype=["{]*["']number["']/.test(el)) continue;
    if (!/\b(Number|parseFloat|parseInt)\(|\+\s*e\.target\.value/.test(el)) continue;
    const startLine = src.slice(0, m.index!).split("\n").length;
    const span = lines.slice(Math.max(0, startLine - 2), startLine + el.split("\n").length).join("\n");
    if (/ALLOW-NUMBER-COERCE: \S/.test(span)) continue;
    out.push({ file, line: startLine, what: 'a number input read with Number()/parseFloat/parseInt: an emptied box becomes 0. Use NumberField or NumberStepper' });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-number-coercion-of-an-input - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use NumberField from @cobblr/platform-web (a measure) or NumberStepper (a count).");
  process.exit(1);
}
console.log(`lint:no-number-coercion-of-an-input OK`);
