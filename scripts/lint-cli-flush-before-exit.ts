#!/usr/bin/env tsx
// A CLI that calls process.exit must write its output with fs.writeSync, not process.stdout.write or console.log
//
// THE BUG THIS PREVENTS. view-as list output arrived cut at 64 KiB with no error, because process.exit ran before the piped stdout flushed (2026-09-08)
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
  if (!/\bprocess\.exit\(/.test(src)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*\/\//.test(line)) continue;
    if (ASYNC_WRITE.test(line) && !OPT_OUT.test(line)) {
      out.push({ file, line: i + 1, what: "asynchronous write in a file that calls process.exit; use fs.writeSync(1|2, ...)" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:cli-flush-before-exit - ${violations.length} write(s) that process.exit can truncate:`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(
    "On a pipe (docker exec) a stream write is asynchronous and process.exit drops what has\n" +
      "not flushed, silently, past ~64 KiB. Write with fs.writeSync(1, text) / writeSync(2, text),\n" +
      "or annotate a deliberate exception with `// ALLOW-ASYNC-WRITE: <why>`.",
  );
  process.exit(1);
}
console.log("lint:cli-flush-before-exit OK");
