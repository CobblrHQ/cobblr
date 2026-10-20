#!/usr/bin/env tsx
// A script that prints a list one line at a time never ends with process.exit() after it, because stdout into a pipe is written behind node's back and exit drops what the reader has not taken yet
//
// THE BUG THIS PREVENTS. 2026-10-20: lint:test-imports-script --candidates printed 435 tests and its reader received 332 at load 26 (#7576)
//
// THE RULE. In scripts/ (not tests), a loop that prints to stdout (`for (...) console.log(...)`,
// `.forEach(... console.log ...)`) followed within three lines by `process.exit(` is a violation. Node writes
// stdout into a pipe asynchronously on Linux; a line the pipe has no room for waits in node's queue, and
// process.exit() throws the queue away. A slow reader (a loaded box) gets a silent prefix of the list: 1008 of
// 3000 lines when the reader waited one second. Pass: set process.exitCode and let the script end, or print the
// list and end without exit, or `await exitWhenWritten(code)` (lib/exit-when-written.mjs), which exits once stdout has
// taken it all. An exit that is safe says why on its line:
// `// exit-after-list: <reason>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. console.error lists (a lint's violations) are for a person
// and short, and every lint scaffolded from the template ends that way; the rule judges stdout, the stream a
// program reads as data, which is where #7576's reader lost 103 tests. A print not in a loop is not judged. A
// line opening `} else` ends the list's path: compute-per-route's `} else { usage; process.exit(2) }` is
// another branch, never reached after the list, and was the first false positive.
//
// PROVEN RED 2026-10-20 against lint-test-imports-script.ts's --candidates and 15 other scripts.
//
//   npx tsx scripts/lint-list-output-is-not-cut-at-exit.ts   (pnpm lint list-output-is-not-cut-at-exit)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["scripts"];

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
    else if (/\.(ts|mts|mjs)$/.test(name) && !/\.test\.(ts|mts|mjs)$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    const listsToStdout = /\bfor\s*\(.*\)\s*\{?\s*console\.log\(/.test(line) || /\.forEach\(.*console\.log\(/.test(line);
    if (!listsToStdout) continue;
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
      const after = lines[j] ?? "";
      // An exit in the next branch (`} else { ...; process.exit(2) }`) is another path, never reached after the list.
      if (/^\s*\}\s*else\b/.test(after)) break;
      if (!/\bprocess\.exit\(/.test(after)) continue;
      if (/\/\/ exit-after-list: \S/.test(after)) break;
      out.push({ file, line: j + 1, what: `process.exit() right after the list printed at line ${i + 1}: a slow reader gets a cut list` });
      break;
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:list-output-is-not-cut-at-exit - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("set process.exitCode and let the script end, or await exitWhenWritten(code) from scripts/lib/exit-when-written.mjs");
  process.exitCode = 1;
} else console.log(`lint:list-output-is-not-cut-at-exit OK`);
