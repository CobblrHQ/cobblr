#!/usr/bin/env tsx
// A mutation or save call never reads the debounced copy of a field; it reads the field itself.
//
// THE BUG THIS PREVENTS. Ship saved the previous tracking number when pressed within 400 ms of typing (#7988, 2026-10-22); the form submitted the state a timer follows the field with.
//
// THE RULE. In a UI file, state that a timer sets from another value
// (`setTimeout(() => setTracking(typed.trim()), 400)`) or that a
// `useDebounce…` hook returns is a debounced copy. It may feed a preview or a
// lookup. It may not appear inside a `mutationFn:` or an `api.<writing verb>(`
// call, where the field's own state belongs: text typed in the last beat
// before the tap is in the field and not yet in the copy. A genuine exception
// says why on the line or the one above: `// DEBOUNCED-OK: <reason>`.
//
// THE BOUNDARY. Only a timer that sets a non-literal counts: `setTimeout(() =>
// setCopied(false), 1500)` is a flash, not a copy of a field. A search box
// whose debounced value reaches `api.search(` is the use the debounce is for,
// and `search` is not a writing verb, so it passes. Nothing has yet drawn the
// line further than that; a save reading the debounced value through a helper
// function is not seen.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-submit-never-reads-debounced.ts   (pnpm lint submit-never-reads-debounced)
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

/** The names a file debounces: state a timer sets from something else (`setTimeout(() => setX(typed)`),
 *  and the result of a `useDebounce…` hook. A timer that sets a literal (`setCopied(false)`) is a flash, not a copy. */
function debouncedNames(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/setTimeout\(\s*(?:\(\)\s*=>|function\s*\(\)\s*)\s*\{?\s*set([A-Z]\w*)\(\s*(?!false\b|true\b|null\b|\d|""|'')/g)) {
    const n = m[1]!;
    names.add(n[0]!.toLowerCase() + n.slice(1));
  }
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*useDebounce\w*\(/g)) names.add(m[1]!);
  return names;
}

/** Where a value is saved: a mutation's body, or a call to an api verb that writes. */
const SAVE_START = /mutationFn\s*:|\bapi\.(?:create|update|ship|save|delete|remove|post|patch|put|submit|file|confirm|add|rename|move|send|set)\w*\(/g;

/** The text from `start` to the end of the expression: a comma at depth 0, or the closer of the enclosing group. */
function expressionEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth < 0) return i;
    } else if (c === "," && depth === 0) return i;
  }
  return src.length;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const names = debouncedNames(src);
  if (!names.size) return out;
  const lines = src.split("\n");
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(SAVE_START)) {
    const from = m.index!;
    const region = src.slice(from, expressionEnd(src, from + m[0].length));
    for (const name of names) {
      for (const hit of region.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
        const line = lineOf(from + hit.index!);
        if (/DEBOUNCED-OK: /.test(lines[line - 1] ?? "") || /DEBOUNCED-OK: /.test(lines[line - 2] ?? "")) continue;
        out.push({ file, line, what: `${name} is the debounced copy of a field and is read where it is saved` });
      }
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:submit-never-reads-debounced - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Read the field's own state in the save; keep the debounced value for previews and lookups, or annotate the line // DEBOUNCED-OK: <reason>.");
  process.exit(1);
}
console.log(`lint:submit-never-reads-debounced OK`);
