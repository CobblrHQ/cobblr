#!/usr/bin/env tsx
// An api test fires at most 16 requests at the shared api at once, or says why on a // BURST: line, because a burst of 40 or 60 holds the api's database clients and a neighbouring file times out waiting for one.
//
// THE BUG THIS PREVENTS. main red at 55867c673 (2026-10-16): every-sales-order-is-counted-and-reachable-past-500 seeded 40 and 60 at a time, held 57 clients, and digifab-runs timed out
//
// THE RULE. Inside api/tests, a `Promise.all(Array.from({ length: N }, ...))` whose N is a number over
// MAX_AT_ONCE (16), or `Math.min(N, ...)` with such an N, fails unless one of the three lines above it says
// `// BURST: <why>`. A seed goes through mapLimit (api/tests/map-limit.ts), a few at a time. A burst that IS
// the test (two writers racing one invoice number, a checkout counted across many reads) says so.
//
// THE BOUNDARY. A burst of 10 (a source id written by ten pushers at once, ten uploads measured for the
// api's memory) is under the line on purpose: those are the races themselves and hold ten clients. A
// `Promise.all(xs.map(...))` over a list is judged only where the source says its length: `xs` is pushed to in a
// `for (let i = 0; i < N; ...)` loop whose N is a number or a const of this file (2026-10-27: sixty reads of
// `parts.map(qtyOf)` took 35 of the api's 86 meta clients and failed run 59700, every test green).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-api-test-bursts-are-bounded.ts   (pnpm lint api-test-bursts-are-bounded)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/tests"];

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
    else if (/\.(ts|tsx)$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
const MAX_AT_ONCE = 16;

function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const m of src.matchAll(/Promise\.all\(\s*Array\.from\(\{\s*length:\s*(?:Math\.min\(\s*)?(\d+)/g)) {
    const n = Number(m[1]);
    if (n <= MAX_AT_ONCE) continue;
    const line = src.slice(0, m.index ?? 0).split("\n").length;
    const above = lines.slice(Math.max(0, line - 4), line).join("\n");
    if (/\/\/ BURST: \S/.test(above)) continue;
    out.push({ file, line, what: `${n} requests at once (over ${MAX_AT_ONCE}) with no // BURST: <why> above it` });
  }
  const consts = new Map([...src.matchAll(/\bconst\s+(\w+)\s*=\s*(\d+)\s*;/g)].map((m) => [m[1]!, Number(m[2])]));
  const sized = new Map<string, number>();
  for (const m of src.matchAll(/for\s*\(\s*let\s+(\w+)\s*=\s*0\s*;\s*\1\s*<\s*(\w+)\s*;[^)]*\)\s*\{/g)) {
    const n = /^\d+$/.test(m[2]!) ? Number(m[2]) : consts.get(m[2]!);
    if (n === undefined || n <= MAX_AT_ONCE) continue;
    let depth = 1, i = (m.index ?? 0) + m[0].length;
    for (; i < src.length && depth; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
    for (const p of src.slice((m.index ?? 0) + m[0].length, i).matchAll(/\b(\w+)\.push\(/g)) sized.set(p[1]!, Math.max(n, sized.get(p[1]!) ?? 0));
  }
  for (const m of src.matchAll(/Promise\.all\(\s*(\w+)\.map\(/g)) {
    const n = sized.get(m[1]!);
    if (n === undefined) continue;
    const line = src.slice(0, m.index ?? 0).split("\n").length;
    const above = lines.slice(Math.max(0, line - 4), line).join("\n");
    if (/\/\/ BURST: \S/.test(above)) continue;
    out.push({ file, line, what: `${n} requests at once over ${m[1]} (filled to ${n} by a loop; over ${MAX_AT_ONCE}) with no // BURST: <why> above it` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:api-test-bursts-are-bounded - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("seed through mapLimit (api/tests/map-limit.ts), a few at a time");
  process.exit(1);
}
console.log(`lint:api-test-bursts-are-bounded OK`);
