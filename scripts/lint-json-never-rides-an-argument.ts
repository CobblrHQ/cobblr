#!/usr/bin/env tsx
// A shell script hands a JSON payload to python or node on stdin or in a file, never as a command-line argument
//
// THE BUG THIS PREVENTS. merge-pr's shared-close check passed a page of fifty open pull requests to python as argv, past the 128 KB one argument may carry, and failed open with Argument list too long (2026-09-30)
//
// THE RULE. Inside a shell script, an inline program that parses JSON out of
// its own arguments fails: `json.loads(sys.argv[...])` in python,
// `JSON.parse(process.argv[...])` in node. Linux caps one argument at 128 KB
// (MAX_ARG_STRLEN), so a payload that grows with the data (a page of pull
// requests, a list of issues) works on a quiet day and dies on a busy one,
// and a script that reads the failure as "not a list" fails open. Send it on
// stdin or in a file. A genuine exception says why on the line:
// `# JSON-ARGV-OK: <why it is bounded>`.
//
// THE BOUNDARY. Only shell scripts and git hooks, where the argument comes
// from a variable of unknown size. A TypeScript script reading its own argv
// takes names and flags, not payloads, and is not judged. Nothing has tested
// the boundary yet.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-json-never-rides-an-argument.ts   (pnpm lint json-never-rides-an-argument)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    else if (/\.(sh|bash)$/.test(name) || p.includes(`${join("scripts", "git-hooks")}`) || p.includes(`${join("scripts", "hooks")}`)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/json\.loads?\(\s*sys\.argv|JSON\.parse\(\s*process\.argv/.test(line) && !/JSON-ARGV-OK: \S/.test(line)) {
      out.push({ file, line: i + 1, what: "JSON parsed out of a command-line argument: one argument holds 128 KB at most, so a growing payload fails; send it on stdin or in a file" });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:json-never-rides-an-argument - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("pipe it: printf '%s' \"$json\" | python3 -c '... json.load(sys.stdin) ...'");
  process.exit(1);
}
console.log(`lint:json-never-rides-an-argument OK`);
