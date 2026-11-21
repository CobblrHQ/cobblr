#!/usr/bin/env tsx
// A page opens a live server stream (EventSource) only through openLiveStream in web/src/lib/live-stream.ts, which reads again what a drop missed and reopens on wake.
//
// THE BUG THIS PREVENTS. A phone locked for a few seconds came back to a teammate's rename that never showed, a minute later and until a reload: its stream dropped and reconnected without catching up (2026-11-20, #4115)
//
// THE RULE. `new EventSource(` appears only in web/src/lib/live-stream.ts.
// A stream opened anywhere else reconnects on its own terms, and a change said
// while it was down is never said again: the page goes on showing what it had
// until a reload. A stream whose events are only of the moment (a drive
// command, nothing to read again) says why on a `// stream-gap-ok:` line, on
// its own line or the one above.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Tests are not judged: their
// fake streams stand in for the real one. A word in a comment is not a call
// (stripComments).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-a-live-stream-never-leaves-a-gap.ts   (pnpm lint a-live-stream-never-leaves-a-gap)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { stripComments } from "./lib/source-scan.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

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
  if (/\.test\.tsx?$/.test(file) || file.endsWith("web/src/lib/live-stream.ts")) return [];
  const lines = src.split("\n");
  const code = stripComments(src).split("\n");
  const out: Violation[] = [];
  code.forEach((l, i) => {
    if (!/\bnew EventSource\(/.test(l)) return;
    if (/\/\/ stream-gap-ok: \S/.test(`${lines[i - 1] ?? ""}\n${lines[i]}`)) return;
    out.push({ file, line: i + 1, what: "a live stream opened outside openLiveStream: a change said while it was down is never said again" });
  });
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:a-live-stream-never-leaves-a-gap - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("openLiveStream({ ticket, url, on, back }) from web/src/lib/live-stream.ts, or // stream-gap-ok: <why a gap loses nothing>");
  process.exit(1);
}
console.log(`lint:a-live-stream-never-leaves-a-gap OK`);
