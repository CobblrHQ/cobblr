#!/usr/bin/env tsx
// A className names a btn-* class only when a stylesheet defines it; there is no button class in this app, so an invented one leaves the button unstyled.
//
// THE BUG THIS PREVENTS. the join page's Go home and the People page's buttons named btn-secondary / btn-primary / btn-danger, which no stylesheet defines, and rendered as bare text (2026-09-28)
//
// THE RULE. Any `btn-<word>` token inside a className string (or a class
// constant beside one) must be a class some stylesheet under web/src,
// packages or modules defines (`.btn-<word>`). Tailwind has no such utility,
// and this app defines none today, so every one is an invention; spell the
// utilities out, as every other button here does.
//
// THE BOUNDARY. Only `btn-` tokens: a misspelt utility in general is
// Tailwind's to catch, and it cannot see an invented component class. Test
// files are skipped (they may assert on a class a fixture sets).
//
// Proven red on the four buttons that motivated it before they were fixed.
//
//   npx tsx scripts/lint-btn-class-defined.ts   (pnpm lint btn-class-defined)
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

/** Every `.btn-<word>` a stylesheet defines. */
function definedBtnClasses(): Set<string> {
  const out = new Set<string>();
  const css = function* (dir: string): Generator<string> {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) yield* css(p);
      else if (/\.css$/.test(name)) yield p;
    }
  };
  for (const root of [...ROOTS, "packages"]) {
    for (const f of css(root)) for (const m of readFileSync(f, "utf8").matchAll(/\.(btn-[a-z0-9-]+)/g)) out.add(m[1]!);
  }
  return out;
}
const DEFINED = definedBtnClasses();

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/class(Name)?\b|Cls\b|_CLASS|className=/.test(line) && !/["'`][^"'`]*\bbtn-/.test(line)) continue;
    for (const m of line.matchAll(/["'`\s](btn-[a-z0-9-]+)(?=[\s"'`])/g)) {
      const cls = m[1]!;
      if (!DEFINED.has(cls)) out.push({ file, line: i + 1, what: `class "${cls}" is defined by no stylesheet, so the element is unstyled` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:btn-class-defined - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:btn-class-defined OK`);
