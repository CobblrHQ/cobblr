#!/usr/bin/env tsx
// Red text that only works in one theme.
//
// `text-ember-600` is the error/destructive colour, and against a dark surface
// it is close enough to the background to be unreadable — a "Delete" that you
// can see is there and cannot quite read. Reported on the selection bar
// (2026-08-22) and found in 28 places across 20 files, because every one of
// them looks fine in whichever theme its author had open.
//
// So: a dark ember TEXT class must ship with a dark-mode variant. The rest of
// the palette is not this lint's business — ember is, because it is the colour
// the app reserves for the actions you cannot take back.
//
// Run: npx tsx scripts/lint-dark-mode-ember.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
/** Shades dark enough to disappear on a dark surface. */
const NEEDS_DARK = /(?<![:\w-])text-ember-(600|700|800|900)\b/;
/** A `dark:` variant of the same colour, at any shade. */
const HAS_DARK = /dark:text-ember-\d+/;
/** Every quoted string: className is often built in a template literal or a
 *  concatenation, not only in a plain `className="…"` attribute. */
const STRINGS = /"[^"\n]*"|'[^'\n]*'|`[^`]*`/g;

const roots = ["web/src", "packages/platform-web/src", "modules"];
const files: string[] = [];
for (const r of roots) {
  try {
    (function walk(dir: string) {
      for (const e of readdirSync(join(ROOT, dir))) {
        if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
        const rel = join(dir, e);
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (rel.endsWith(".tsx")) files.push(rel);
      }
    })(r);
  } catch { /* optional tree */ }
}

const bad: string[] = [];
for (const rel of files) {
  readFileSync(join(ROOT, rel), "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const lit of line.match(STRINGS) ?? []) {
        if (NEEDS_DARK.test(lit) && !HAS_DARK.test(lit)) {
          bad.push(`${rel}:${i + 1}  ${lit.slice(0, 80)}`);
        }
      }
    });
}

if (bad.length) {
  console.error(
    "[lint:dark-mode-ember] ✗ destructive red with no dark-mode variant — unreadable on a dark surface:\n",
  );
  for (const b of bad) console.error("  " + b);
  console.error(
    "\n  Add a dark variant in the SAME class string, e.g.\n" +
      '    "text-ember-600 dark:text-ember-400"\n' +
      "  (600/700 → dark:text-ember-400, 800/900 → dark:text-ember-300.)\n" +
      "  A className built across several lines needs it in the same literal as the base class.",
  );
  process.exit(1);
}
console.log(`lint:dark-mode-ember ✓ ${files.length} files, every destructive red reads in both themes.`);
