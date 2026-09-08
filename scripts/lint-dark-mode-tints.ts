#!/usr/bin/env tsx
// A raw light tint that only works in one theme.
//
// The semantic tokens (bg-surface, bg-subtle, text-content, ...) carry their
// own dark values now, so anything written in them reads in both themes with
// nothing else on the element. This lint is for what is NOT written in them:
// a raw palette tint - `bg-amber-50`, `bg-white`, `text-slate-800` - that looks
// right in whichever theme its author had open and is a cream panel with
// invisible text in the other. lint:dark-mode-ember holds the same line for the
// destructive red; this is the rest of the palette.
//
// The rule: in one class string, a light BACKGROUND tint (`bg-white`, or any
// palette colour at shade 50 or 100) must come with a `dark:bg-`, and a dark
// TEXT shade (600 and up, or `text-black`) must come with a `dark:text-`. Or
// write it in the tokens, which is the better answer.
//
// Existing debt is pinned in scripts/dark-mode-tints-baseline.json so this
// fails only on NEW instances; `--update` rewrites the baseline after a fix.
//
// Run: npx tsx scripts/lint-dark-mode-tints.ts [--update]
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const BASELINE = join(ROOT, "scripts", "dark-mode-tints-baseline.json");
const PALETTE = "(?:slate|mortar|cobble|moss|amber|red|green|blue|yellow|orange|emerald|sky|rose|indigo|violet|purple|pink|teal|cyan|lime|stone|zinc|gray|neutral)";
/** A light background nothing dark was asked for. */
const LIGHT_BG = new RegExp(`(?<![:\\w-])bg-(?:white|${PALETTE}-(?:50|100))(?![\\w-])`);
const HAS_DARK_BG = /dark:(?:hover:)?bg-/;
/** Text dark enough to vanish on a dark surface. Ember has its own lint. */
const DARK_TEXT = new RegExp(`(?<![:\\w-])text-(?:black|(?:slate|mortar|cobble|moss|amber|red|green|blue|yellow|orange|emerald|sky|rose|indigo|violet|purple|pink|teal|cyan|lime|stone|zinc|gray|neutral)-(?:600|700|800|900|950))(?![\\w-])`);
const HAS_DARK_TEXT = /dark:(?:hover:)?text-/;
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
        else if (rel.endsWith(".tsx") && !rel.includes(".test.")) files.push(rel);
      }
    })(r);
  } catch { /* optional tree */ }
}

/** Keyed by file + the literal, not the line, so an edit above does not
 *  re-flag a baselined instance. */
const found = new Map<string, string>();
for (const rel of files) {
  readFileSync(join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
    for (const lit of line.match(STRINGS) ?? []) {
      // A `dark` inside the literal at all means the author thought about it;
      // the two checks below ask whether the RIGHT half was covered.
      const bg = LIGHT_BG.test(lit) && !HAS_DARK_BG.test(lit);
      const tx = DARK_TEXT.test(lit) && !HAS_DARK_TEXT.test(lit);
      if (bg || tx) found.set(`${rel}::${lit}`, `${rel}:${i + 1}  ${lit.slice(0, 90)}`);
    }
  });
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify([...found.keys()].sort(), null, 2) + "\n");
  console.log(`lint:dark-mode-tints baseline rewritten: ${found.size} instance(s).`);
  process.exit(0);
}
const baseline = new Set<string>(existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as string[]) : []);
const fresh = [...found.entries()].filter(([k]) => !baseline.has(k)).map(([, v]) => v);
const gone = [...baseline].filter((k) => !found.has(k)).length;
if (fresh.length > 0) {
  console.error(`✗ lint:dark-mode-tints — ${fresh.length} raw tint(s) with no dark-mode counterpart:\n`);
  console.error(fresh.map((f) => "  " + f).join("\n"));
  console.error(`\nA light bg-* tint needs a dark:bg-*, a dark text-* shade needs a dark:text-*.
Better: write it in the tokens (bg-surface / bg-subtle / text-content / text-muted /
text-faint / border-line), which carry their own dark values. Or, if this is
genuinely one-theme UI (a print sheet, a camera overlay under .force-dark), run
  pnpm run lint:dark-mode-tints -- --update
to accept it into the baseline, and say why in the PR.`);
  process.exit(1);
}
console.log(`✓ lint:dark-mode-tints — ${files.length} files, no new one-theme tints${gone ? ` (${gone} baselined instance(s) are gone; --update to shrink the baseline)` : ""}.`);
