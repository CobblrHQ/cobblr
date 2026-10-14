#!/usr/bin/env tsx
// An e2e probe that asks whether something is on screen filters to visible matches before it takes the first: a page that renders a desktop and a phone layout keeps a hidden copy of the same text earlier in the DOM.
//
// THE BUG THIS PREVENTS. mobile-overflow.mjs refused /inventory at 390px on every main run: getByText(name).first() took the desktop table's hidden link, so the positive control read 'not on screen' while the phone card showed the part (#3521)
//
// Measured on the real page (dev rig, 390px, 2026-09-23): the part's name is
// two <a> links, the first under the desktop table's `hidden md:block`
// wrapper. Unfiltered `.first().isVisible()` read false; filtered, true. A
// hand-built static page with the same shape did NOT reproduce it, so the
// rule is held here rather than trusted to intuition about which match
// Playwright takes first.
//
// THE RULE. A chain that ends `.first().isVisible(` must say which matches it
// takes the first of: `.filter({ visible: true })` (or a `visible=true` /
// `:visible` selector) earlier in the same chain. A probe that really means
// "the first match, shown or not" asks with `.count()` or
// `.first().textContent()` instead, never `isVisible`.
//
//   npx tsx scripts/lint-e2e-visible-probe-filters-first.ts   (pnpm run lint:e2e-visible-probe-filters-first)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["e2e"];

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
    // _tmp is a walk's local scratch, never committed.
    if (name === "node_modules" || name === "dist" || name === "_tmp" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(mjs|js|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const PROBE = /\.first\(\)\s*\.isVisible\(/;
const FILTERED = /visible:\s*true|visible=true|:visible\b/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (PROBE.test(line) && !FILTERED.test(line)) {
      out.push({ file, line: i + 1, what: ".first().isVisible() on an unfiltered locator: the first match may be a copy hidden at this width" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:e2e-visible-probe-filters-first - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("insert .filter({ visible: true }) before .first()");
  process.exit(1);
}
console.log(`lint:e2e-visible-probe-filters-first OK`);
