#!/usr/bin/env tsx
// A write that refuses to put a thing inside itself takes a lock for its check and its write, because two such writes at once each pass the check and both are saved
//
// THE BUG THIS PREVENTS. #9638 and #9649: two boxes, then two builds, put inside each other at once both saved; the boxes hung every read
//
// THE RULE. A write that refuses to put a thing inside itself walks up from
// where it goes and refuses when it meets the thing. Two such writes at once
// (A into B, B into A) each walk before the other lands, each pass, and both
// are saved. So a file whose code refuses a loop (its refusal says so: "inside
// itself", "a tag loop", "already made with this build", "containment cycle")
// takes pg_advisory_xact_lock (or a helper that does: lockTree,
// lockPlacements) around the walk and the write. A refusal that cannot race
// (a thing naming itself, with no walk; a plan that writes nothing) says why
// on a `// LOOP-SAFE: <why>` line on or just above it.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A place naming itself as its
// own parent (locations.ts) is refused with "cannot go inside itself" and
// needs no lock: no walk, nothing another write can change. The real walk is
// place-move.ts, which locks. And the location import's plan reports "a loop
// of rows" without writing. Both carry LOOP-SAFE; the lint matches refusal
// wording, not any word "loop" (a lifecycle, a duty cycle).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-loop-checks-hold-a-lock.ts   (pnpm lint loop-checks-hold-a-lock)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** A refusal of a loop, by what it says to the person (or its code). */
export const LOOP_REFUSAL = /inside itself|contains? itself|containment cycle|would (?:create a |make a )?(?:tag )?loop|make a loop|already made with this build|into_itself|loop of rows/;
/** The lock a loop check holds, taken directly or through a helper that takes it. */
export const HOLDS_A_LOCK = /pg_advisory_xact_lock|\block(?:Tree|Placements)\(/;
const SAFE = /\/\/\s*LOOP-SAFE:\s*\S/;

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  // A page that says it cannot be done is not the write; the write is judged where it runs.
  if (/\/ui\/|\.tsx$/.test(file) || HOLDS_A_LOCK.test(src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // A comment naming a loop is its explanation, not a refusal.
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || !LOOP_REFUSAL.test(line)) continue;
    if (SAFE.test(line) || SAFE.test(lines[i - 1] ?? "") || SAFE.test(lines[i - 2] ?? "")) continue;
    out.push({ file, line: i + 1, what: "refuses a loop, and the file takes no lock for its check and its write" });
  }
  return out;
}

// Run as a lint, never on import (its test imports check).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const violations: Violation[] = [];
  // The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
  for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

  if (violations.length) {
    console.error(`lint:loop-checks-hold-a-lock - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("take pg_advisory_xact_lock in a transaction around the walk and the write, or say on a LOOP-SAFE: line why two at once cannot both pass");
    process.exit(1);
  }
  console.log(`lint:loop-checks-hold-a-lock OK`);
}
