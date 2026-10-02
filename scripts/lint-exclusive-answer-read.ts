#!/usr/bin/env tsx
// A run under the exclusive lock reads whether it ran: a caller that reports what it did uses the outcome's ran, and one that may safely skip (a timer tick) says so on the line above with SKIP-IF-BUSY OK: <why>.
//
// THE BUG THIS PREVENTS. A share's Sync now read a busy lock as nothing to send and answered sent 0 with a change still waiting; CI caught it once (2026-10-03)
//
// THE RULE. A call to runExclusive (kernel) or platform().exclusive.run
// (modules) passes when:
//   - its outcome is kept (`const run = await runExclusive(...)`, or returned)
//     and that name is read as `run.ran` in the same file; or
//   - the line above it says `// SKIP-IF-BUSY OK: <why>`: a timer tick whose
//     next round tries again, where a skip is the right answer and nothing is
//     reported to anyone.
// It fails when the outcome is dropped with no such line, and when a kept
// outcome is never read as `.ran` (the outcome is an object; `if (!run)` is
// always false and the type checker does not say so).
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The timer ticks (delivery
// sweeper, photo retention, the reapers, the share sync loop) drop the outcome
// and are right to: they carry the annotation instead of a carve-out, so a new
// tick has to say it is one. The definition and its re-exports in
// api/src/platform/exclusive.ts are not calls.
//
// PROVE IT RED: on the commit before the Sync now fix, share-sync.ts dropped
// the outcome of its flush and reported "sent 0".
//
//   npx tsx scripts/lint-exclusive-answer-read.ts   (pnpm lint exclusive-answer-read)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules"];

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

const CALL = /\b(runExclusive|exclusive\.run)\(/;
const ANNOTATED = /\/\/\s*SKIP-IF-BUSY OK:\s*\S.{6,}/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const code = line.replace(/\/\/.*$/, "");
    if (!CALL.test(code)) continue;
    if (/^\s*(import|export)\b/.test(code) || /function\s+runExclusive\b/.test(code) || /\brun:\s*runExclusive\b/.test(code)) continue;
    const kept = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?[\w.()]*?(?:runExclusive|exclusive\.run)\(/.exec(code);
    if (kept) {
      const name = kept[1]!;
      if (!new RegExp(`\\b${name}\\.ran\\b`).test(src)) {
        out.push({ file, line: i + 1, what: `keeps the outcome as "${name}" but never reads ${name}.ran (an outcome object is always truthy)` });
      }
      continue;
    }
    if (/\breturn\s+(?:await\s+)?[\w.()]*?(?:runExclusive|exclusive\.run)\(/.test(code)) continue;
    const above = [lines[i - 1] ?? "", lines[i - 2] ?? ""];
    if (above.some((l) => ANNOTATED.test(l))) continue;
    out.push({ file, line: i + 1, what: "drops whether it ran: a busy lock reads as done" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:exclusive-answer-read - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Read .ran from the outcome, or annotate // SKIP-IF-BUSY OK: <why it is safe to skip>");
  process.exit(1);
}
console.log(`lint:exclusive-answer-read OK`);
