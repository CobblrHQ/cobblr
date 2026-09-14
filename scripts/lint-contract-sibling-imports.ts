#!/usr/bin/env tsx
// A file in a package the api runs as .ts source (platform-contract, platform-net) imports a sibling through the package's own subpath export, never a relative ./x.js value import, which node's type stripping cannot resolve and which unmounts every module api that loads the file.
//
// THE BUG THIS PREVENTS. scan-triage.ts imported ./acquisition-source.js and core-scan's whole api failed to import on the throwaway box: every scan route 404 with no test naming the cause (2026-09-14); the same shape had unmounted core-ai's api in CI before
//
// THE RULE. Under the roots below, a line that imports or re-exports a VALUE
// from a relative path (`from "./x.js"`, `from "../x.js"`) fails; `import
// type { ... } from "./x.js"` and `export type` pass, because the stripper
// drops them. The api loads these packages straight from src through node's
// type stripping, which resolves the relative `.js` specifier literally and
// finds no such file; the module that imported the package logs "failed to
// import api" and carries on with that api unmounted. A test file is not
// judged (vitest transforms it). A genuine exception opts out with
// `// SIBLING-IMPORT OK: <reason>` on the line.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-contract-sibling-imports.ts   (pnpm run lint:contract-sibling-imports)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["packages/platform-contract/src", "packages/platform-net/src"];

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

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  // A multi-line import's `from` sits on a later line than its keyword, so
  // the statement is judged from the line that opens it.
  let stmt = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!stmt && /^\s*(import|export)\b/.test(line)) {
      stmt = "";
      start = i;
    }
    if (/^\s*(import|export)\b/.test(line) || stmt) {
      stmt += line + "\n";
      if (!/;\s*$|from\s+"[^"]+"\s*;?\s*$/.test(line) && !/^\s*(import|export)\s+type\b/.test(line) && !/from/.test(stmt)) continue;
      const m = /from\s+"(\.\.?\/[^"]+)"/.exec(stmt);
      const typeOnly = /^\s*(import|export)\s+type\b/.test(stmt);
      if (m && !typeOnly && !/\/\/ SIBLING-IMPORT OK: /.test(stmt)) {
        out.push({ file, line: start + 1, what: `runtime import from "${m[1]}"; use the package's subpath export` });
      }
      stmt = "";
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:contract-sibling-imports - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Import the sibling as @cobblr/<package>/<subpath> (add the subpath to the package's exports if it has none); a type-only import may stay relative.");
  process.exit(1);
}
console.log(`lint:contract-sibling-imports OK`);
