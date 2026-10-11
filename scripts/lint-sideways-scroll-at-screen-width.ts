#!/usr/bin/env tsx
// A browser check for sideways scroll compares the page's width with the screen's own width (the viewport the test set, or document.documentElement.clientWidth), never with window.innerWidth, which a phone context widens to fit an overflowing page.
//
// THE BUG THIS PREVENTS. #5809: a 7 m planned rack widened a 390 px phone page to 420 px; scrollWidth equalled innerWidth, so every walk at 390 passed
//
// THE RULE. A line that measures the page's width (`scrollWidth`) against
// `innerWidth` fails. Compare with the screen: page.viewportSize().width, or
// document.documentElement.clientWidth inside the page (it stays at the
// screen's width when the window grows). A line that reads innerWidth on
// purpose says so: `// ALLOW-INNER-WIDTH: <why>` (walk.mjs takes the larger
// of the two and judges it against the viewport).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Only the page-width
// comparison, on one line: an element-edge check that reads innerWidth for a
// box's right edge (mobile-nav-fits, scan-header-margin) is a different
// measurement and is not judged. A comment explaining the trap
// (mobile-audit.mjs) is not judged either.
//
//   npx tsx scripts/lint-sideways-scroll-at-screen-width.ts   (pnpm lint sideways-scroll-at-screen-width)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["e2e", "scripts"];

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
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (/scrollWidth/.test(line) && /innerWidth/.test(line) && !/ALLOW-INNER-WIDTH: \S/.test(line)) {
      out.push({ file, line: i + 1, what: "the page's width measured against innerWidth, which a phone context widens with the page" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:sideways-scroll-at-screen-width - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("compare with page.viewportSize().width or document.documentElement.clientWidth");
  process.exit(1);
}
console.log(`lint:sideways-scroll-at-screen-width OK`);
