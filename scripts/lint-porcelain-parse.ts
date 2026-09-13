#!/usr/bin/env tsx
// git status --porcelain is run and parsed in one place, scripts/lib/git-porcelain.mjs;
// a script that wants the working tree's paths or statuses imports it.
//
// THE BUG THIS PREVENTS. Porcelain puts the two status columns first, so a file
// modified in the work tree prints with a LEADING space (" M path"). Every git
// helper in scripts/ trims its output, which eats that space on the first line,
// and a fixed slice(3) then drops the first character of the first path. It
// shipped twice: scripts/publish/push-registry.mjs read "EADME.md" (fixed in
// place with a comment), and lint:changelog-names-ui read zero entries and
// passed on the very shape it was written to catch (2026-09-13, #2830). A
// comment at one call site does not reach the next script.
//
// THE RULE. In scripts/**/*.ts and scripts/**/*.mjs, the command
// `git status --porcelain` (and its short forms `-s`, `--short`) may appear only
// in scripts/lib/git-porcelain.mjs, which parses lines by their columns and is
// right whether or not the block was trimmed. Any other script imports
// parsePorcelain / workingTreeStatus / workingTreePaths from it. Tests, the
// .d.mts, and this lint are skipped; shell scripts are out of scope (they use
// porcelain as an emptiness test, and awk splits on whitespace). A genuine
// exception (a script that must run the command with flags the helper lacks)
// says so on the line: `// PORCELAIN: <reason>`.
//
// PROVEN RED on the shape before the fix: lint-changelog-names-ui.ts running
// git("status --porcelain") itself, and push-registry.mjs the same; green once
// both went through the helper.
//
//   npx tsx scripts/lint-porcelain-parse.ts   (pnpm run lint:porcelain-parse)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    else if (/\.(ts|mjs)$/.test(name) && !/\.test\.(ts|mjs)$/.test(name) && !/\.d\.mts$/.test(name)) yield p;
  }
}

/** The one file allowed to run the command. */
const OWNER = "scripts/lib/git-porcelain.mjs";
const SELF = "scripts/lint-porcelain-parse.ts";
const PORCELAIN_RE = /\bstatus\b[^\n]{0,40}?(--porcelain|--short|["'\s]-s["'\s,)])/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (file === OWNER || file === SELF) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
    if (!PORCELAIN_RE.test(line)) continue;
    if (/\/\/ PORCELAIN: \S/.test(line)) continue;
    out.push({
      file,
      line: i + 1,
      what: `runs git status --porcelain itself; import parsePorcelain / workingTreeStatus / workingTreePaths from ${OWNER} (a trimmed block loses the first path's first character; the helper parses by columns)`,
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:porcelain-parse - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:porcelain-parse OK`);
