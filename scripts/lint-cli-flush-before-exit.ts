#!/usr/bin/env tsx
// A CLI that calls process.exit must write its output with fs.writeSync, not process.stdout.write or console.log
//
// THE BUG THIS PREVENTS. view-as list output arrived cut at 64 KiB with no error, because process.exit ran before the piped stdout flushed (2026-09-08)
//
// AND ITS SECOND INSTANCE, one directory over (2026-09-17, #3167): the CI
// typecheck job's log stopped at 66,355 bytes mid-word, with no vitest summary
// and no failing test, on the one run anyone needed to read. Not a killed
// process, as it was first diagnosed, but the same race: run-parallel.mjs
// printed the unit-test block (~130 KB) and called process.exit(1) while the
// job's `| tee` still had everything past the pipe's 64 KiB in flight. This
// lint had owned that class for a year and looked only at api/src/cli.
//
// A lint that owns a rule for one directory owns the RULE, not the directory.
// So the harnesses are covered by what they do, not where they live: any
// scripts/ file that imports the parallel runner prints another process's
// captured output, which has no size bound, and is held to the same rule.
// Either form passes: fs.writeSync, or no process.exit at all (set
// process.exitCode and let the pipe drain; the harnesses do the latter).
//
// THE RULE. State it so the next reader can tell a violation from a false
// positive without running the script. Say what passes, what fails, and how
// a genuine exception opts out (an annotation with a reason, never a
// baseline that grows).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-cli-flush-before-exit.ts   (pnpm run lint:cli-flush-before-exit)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites: commands run inside the api container. Their stdout
 *  and stderr are pipes (docker exec), which is exactly where the truncation
 *  happens. */
const ROOTS = ["api/src/cli"];

/** The other place it bites: a harness that prints a child's captured output
 *  into the CI job's pipe. Found by the import, so a new consumer of the
 *  runner is covered the day it is written. */
const HARNESS_ROOT = "scripts";
const PRINTS_CAPTURED_OUTPUT = /\bfrom\s+["']\.{1,2}\/(?:lib\/)?parallel\.mjs["']/;

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
    else if (/\.(ts|mjs)$/.test(name) && !/\.test\.[tm]?js$/.test(name)) yield p;
  }
}

const ASYNC_WRITE = /\bprocess\.(stdout|stderr)\.write\(|\bconsole\.(log|error|warn|info)\(/;
const OPT_OUT = /\/\/ ALLOW-ASYNC-WRITE: /;

/** A file that never calls process.exit lets Node drain the pipe on its own; the
 *  rule only bites where an exit can race the write. */
function check(file: string, src: string): Violation[] {
  const lines = src.split("\n");
  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
  // A comment that names process.exit (to say why the file avoids it) is not a call.
  if (!lines.some((line) => !isComment(line) && /\bprocess\.exit\(/.test(line))) return [];
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isComment(line)) continue;
    if (ASYNC_WRITE.test(line) && !OPT_OUT.test(line)) {
      out.push({ file, line: i + 1, what: "asynchronous write in a file that calls process.exit; use fs.writeSync(1|2, ...)" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));
for (const file of walk(HARNESS_ROOT)) {
  const src = readFileSync(file, "utf8");
  if (PRINTS_CAPTURED_OUTPUT.test(src)) violations.push(...check(file, src));
}

if (violations.length) {
  console.error(`lint:cli-flush-before-exit - ${violations.length} write(s) that process.exit can truncate:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "On a pipe (docker exec, the CI job's `| tee`) a stream write is asynchronous and process.exit\n" +
      "drops what has not flushed, silently, past ~64 KiB. Write with fs.writeSync(1, text) /\n" +
      "writeSync(2, text), or drop the process.exit (set process.exitCode and let the pipe drain),\n" +
      "or annotate a deliberate exception with `// ALLOW-ASYNC-WRITE: <why>`.",
  );
  process.exit(1);
}
console.log("lint:cli-flush-before-exit OK");
