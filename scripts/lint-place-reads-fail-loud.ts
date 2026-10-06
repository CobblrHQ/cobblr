#!/usr/bin/env tsx
// A read of where a thing is kept is never caught into an answer (#4985).
//
// THE BUG THIS PREVENTS. "adds to the picked place" passed only on a retry:
// the pick of the ambulance's row was refused, 409 "That is not one of the
// places this is kept.", in a CI run where the platform database was
// contended. A thing kept in several places is one card with a row per
// place, joined by holding-of pairings in that database, and the scan path
// caught a failed pairing read into an empty answer: "kept nowhere else"
// (placesOfCard) and "each record its own card" (withCards). The same
// swallow stamped a scan as kept in one place, so "+1 more" added it to
// whichever row matched first, a place nobody chose.
//
// THE RULE. A `pairings.findBy...` call whose arguments name HOLDING_OF is
// not followed by `.catch(`, and does not sit in a `try` whose `catch` block
// carries no `throw`. Its failure reaches the caller, which says "could not
// check" instead of answering. A read that may honestly fail soft says why on
// the line above: `// PLACE-READ-MAY-FAIL: <reason>`.
//
// THE BOUNDARY. Only holding-of reads: every other pairing read (a link, an
// instance-of) answers a question whose empty answer is not a place to put
// stock. Writes (create, remove) are not reads. Nothing near-missed yet.
//
//   npx tsx scripts/lint-place-reads-fail-loud.ts   (pnpm lint place-reads-fail-loud)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages"];

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

/** The index just past the `)` that closes the `(` at `open`. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i + 1;
  }
  return src.length;
}

/** The `{` of every block that encloses `at`, innermost first. */
function enclosingBlocks(src: string, at: number): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (src[i] === "}") depth++;
    else if (src[i] === "{") {
      if (depth === 0) out.push(i);
      else depth--;
    }
  }
  return out;
}

/** The body of the `catch` that follows the try block opened at `brace`,
 *  or null when that block is not a try. */
function catchBodyOf(src: string, brace: number): string | null {
  if (!/\btry\s*$/.test(src.slice(Math.max(0, brace - 12), brace))) return null;
  let depth = 0;
  let end = brace;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const m = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(src.slice(end));
  if (!m) return null;
  const open = end + m[0].length - 1;
  depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!src.includes("HOLDING_OF")) return [];
  const out: Violation[] = [];
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  for (const m of src.matchAll(/pairings\s*\.\s*findBy\w+\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closeOf(src, open);
    if (!src.slice(open, close).includes("HOLDING_OF")) continue;
    const line = lineAt(m.index!);
    const above = src.split("\n").slice(Math.max(0, line - 4), line).join("\n");
    if (/\/\/ PLACE-READ-MAY-FAIL: \S/.test(above)) continue;
    if (/^\s*\.\s*catch\s*\(/.test(src.slice(close))) {
      out.push({ file, line, what: "a holding-of read caught with .catch(): a failed read answers as 'kept in one place'" });
      continue;
    }
    for (const brace of enclosingBlocks(src, m.index!)) {
      const body = catchBodyOf(src, brace);
      if (body !== null && !/\bthrow\b/.test(body)) {
        out.push({ file, line, what: "a holding-of read inside a try whose catch does not throw: a failed read answers as 'kept in one place'" });
        break;
      }
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:place-reads-fail-loud - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:place-reads-fail-loud OK`);
