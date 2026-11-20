#!/usr/bin/env tsx
// Ask Cobb says nothing was changed only through what-changed.ts, from the turn's own count of changes; no sentence in core-ai writes it by hand.
//
// THE BUG THIS PREVENTS. a turn that set the bolts to 40 then lost its provider said 'Nothing was changed. Try again', and asking again did it twice (2026-11-20, #4115)
//
// THE RULE. In modules/core-ai/src (not tests), a line that says "nothing
// was changed" (was, has been or is) fails unless it is in what-changed.ts,
// which writes it only when the turn's own count of changes is zero, or it is
// a comment, or it carries `changed-claim-ok: <why>` on it or the line above.
// A sentence a person reads says it by calling saidWithChanges with a count.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Three hand-backs say it to
// the MODEL, not the person, and only on turns that applied nothing (the
// report guard's two, and a failed turn's note); they carry the marker with
// that reason. Other modules' single refusals ("this label has been turned
// off, so nothing was changed") answer one request that ran nothing, so the
// rule stops at core-ai, where a turn can change several things and then fail.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-nothing-changed-from-the-count.ts   (pnpm lint nothing-changed-from-the-count)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules/core-ai/src"];

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (/(^|\/)what-changed\.ts$/.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/nothing (?:was|has been|is) changed/i.test(line)) continue;
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    if (/changed-claim-ok: \S/.test(line) || /changed-claim-ok: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "says nothing was changed by hand, not from the turn's count (what-changed.ts)" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:nothing-changed-from-the-count - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("build the sentence with saidWithChanges(text, changes, { failed: true }) from what-changed.ts");
  process.exit(1);
}
console.log(`lint:nothing-changed-from-the-count OK`);
