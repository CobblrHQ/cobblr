#!/usr/bin/env tsx
// An assistant tool is defined in its own file under packages/workspace-tools/src/tools/, never in tools.ts or another shared file.
//
// THE BUG THIS PREVENTS. tools.ts held all 45 tools, so every pull request
// that added or changed one touched the same file, and it was a top-10 merge
// re-check hotspot (#7388, 2026-10-19). tools.ts now finds the files in
// tools/ itself; a tool written anywhere else in the package would quietly
// bring the shared file back.
//
// THE RULE. Outside tools/, no file in the package holds a tool's object: a
// `mode: "read",` or `mode: "write",` property, which only a tool literal has.
// Inside tools/, tools.ts already refuses a file whose default export is not
// a tool or whose name is not the tool's, so this lint does not repeat that.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The tool TYPE in
// tool-kit.ts says `mode: "read";` with a semicolon; a literal says it with a
// comma, so the type is not a violation. Tests build fake tools freely and are
// not judged.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-tools-live-in-their-own-files.ts   (pnpm lint tools-live-in-their-own-files)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["packages/workspace-tools/src"];
const TOOL_DIR = join("packages", "workspace-tools", "src", "tools");

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
    if (join(dir, name) === TOOL_DIR) continue;
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\bmode:\s*["'](read|write)["']\s*,/.test(line)) out.push({ file, line: i + 1, what: "a tool defined outside tools/" });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:tools-live-in-their-own-files - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("move the tool to packages/workspace-tools/src/tools/<its-name-with-dashes>.ts as its default export");
  process.exit(1);
}
console.log(`lint:tools-live-in-their-own-files OK`);
