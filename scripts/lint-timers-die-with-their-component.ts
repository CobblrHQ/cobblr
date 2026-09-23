#!/usr/bin/env tsx
// A timer a component or hook starts is cancelled when it unmounts: its handle is kept and cleared, or it goes through useLater, or the line says why it must outlive the component.
//
// THE BUG THIS PREVENTS. main red at a4e8d1eca, 2026-09-22: every test passed and one unhandled window-is-not-defined from a 1.2s flash timer in use-invoke-action failed the run (#3463)
//
// It was blamed on whichever test file happened to be running, came and went
// with how long the rest of the suite took, and did not reproduce with the
// blamed file run alone: the shape of a flake in somebody else's work. In a
// browser the same timer is a wasted update on a component that is gone.
//
// THE RULE, per call site (setTimeout and setInterval), in React code (every .tsx, and a .ts that calls a
// hook) under web/src, packages/platform-web/src and a module's ui/:
//   - a `setTimeout` whose handle is thrown away (a bare statement, the body
//     of an arrow, after `&&`) can never be cleared: a violation;
//   - one whose handle is stored (`t = setTimeout(...)`, `ref.current = ...`)
//     must have a `clearTimeout(<that name>` in the same file;
//   - a handle handed on (`return setTimeout`, an argument, a `push(`) is its
//     receiver's to clear, and passes;
//   - a promise sleep (`new Promise((r) => setTimeout(r, ms))`) holds no
//     state of its own, and passes.
// The fix is `useLater()` from @cobblr/platform-web (one timer per key, all
// cleared on unmount), or a kept handle cleared in an effect's cleanup. A
// timer that must outlive its component (revoking an object URL, say) says
// so on its own line or the one above: `// TIMER-OUTLIVES-COMPONENT: <why>`.
// There is no baseline: every site that stood when this landed was fixed or
// given its reason.
//
//   npx tsx scripts/lint-timers-die-with-their-component.ts   (pnpm run lint:timers-die-with-their-component)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

const CALL = /(?<![\w.$])(?:window\.)?(setTimeout|setInterval)\s*\(/g;
const ESCAPE = /TIMER-OUTLIVES-COMPONENT:\s*\S/;
const SLEEP = /new Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\{?\s*$/;
const HANDED_ON = /(?:\breturn|[(,?:])\s*$/;
const STORED = /((?:[\w$]+\.)*[\w$]+(?:\.current)?)\s*=\s*$/;

/** A file that is React code: a component or a hook, not a plain helper. */
function isReact(file: string, src: string): boolean {
  if (file.endsWith(".tsx")) return true;
  return /\buse[A-Z]\w*\s*\(/.test(src);
}

function inScope(file: string): boolean {
  if (file.startsWith("modules/")) return /\/ui\//.test(file);
  return true;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!inScope(file) || !isReact(file, src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  for (const m of src.matchAll(CALL)) {
    const idx = m.index ?? 0;
    const lineNo = lineOf(idx);
    const here = lines[lineNo - 1] ?? "";
    const above = lines[lineNo - 2] ?? "";
    if (ESCAPE.test(here) || ESCAPE.test(above)) continue;
    // Prose about a timer (a comment, a doc block) is not a timer.
    const col = idx - (src.lastIndexOf("\n", idx - 1) + 1);
    if (here.slice(0, col).includes("//") || /^\s*\*/.test(here)) continue;
    // The code before the call: this line's, else the last non-blank line's.
    let before = here.slice(0, col);
    if (!before.trim()) {
      for (let j = lineNo - 2; j >= 0; j--) {
        const prev = (lines[j] ?? "").replace(/\/\/.*$/, "");
        if (prev.trim()) {
          before = prev;
          break;
        }
      }
    }
    if (SLEEP.test(before)) continue;
    const stored = before.match(STORED);
    if (stored && !/[=!<>]=\s*$|=>\s*$/.test(before)) {
      const name = stored[1]!.replace(/^(?:const|let|var)\s+/, "");
      const esc = name.replace(/[.$]/g, (c) => `\\${c}`);
      if (!new RegExp(`clear(?:Timeout|Interval)\\(\\s*${esc}\\b`).test(src)) {
        out.push({ file, line: lineNo, what: `the ${m[1]} kept in \`${name}\` is never cleared` });
      }
      continue;
    }
    if (HANDED_ON.test(before)) continue;
    out.push({ file, line: lineNo, what: `the ${m[1]}'s handle is thrown away, so nothing can clear it` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:timers-die-with-their-component - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("route it through useLater from @cobblr/platform-web, or keep the handle and clearTimeout it on unmount");
  process.exit(1);
}
console.log(`lint:timers-die-with-their-component OK`);
