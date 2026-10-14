#!/usr/bin/env tsx
// Server code never reads a file when its module loads: a file the image does not carry would stop the api booting, so read inside the handler or embed the content at build time.
//
// THE BUG THIS PREVENTS. the edge-bridge installer route read api/served/*.sh at module load; the hosted overlay image had no api/served, and the api crash-looped on the nightly promote (2026-09-29)
//
// THE RULE. A statement at module scope (a top-level const/let/var, the kind
// that runs the moment the file is imported) must not call readFileSync or
// readFile. Such a read runs at boot for every route file the api loads, so a
// file missing from one image layout takes the whole api down, not the one
// feature. Read inside the handler (a missing file is then that request's
// error) or embed the content at build time. A deliberate boot read says
// `// BOOT-READ-OK: <why>` on the line above it.
//
// THE BOUNDARY. Only module scope: a read inside a function body runs when it
// is called and cannot stop boot, so it is not this rule's business. And not
// a module's src/scripts/ (a CLI run by hand, never imported at boot): the
// first run flagged two of those, which read their own fixtures at the top.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-no-file-reads-at-module-load.ts   (pnpm lint no-file-reads-at-module-load)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    // A CLI script under src/scripts/ runs by hand, never at api boot.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\/scripts\//.test(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!/^(export\s+)?(const|let|var)\s/.test(line)) continue;
    // The whole statement, which may run over several lines: up to the first
    // line that ends it with a semicolon.
    let stmt = line;
    let j = i;
    while (!/;\s*(\/\/.*)?$/.test(lines[j] ?? "") && j < lines.length - 1 && j - i < 40) stmt += "\n" + (lines[++j] ?? "");
    // Source code held in a string (the bridge loader is JS in a TS string)
    // mentions readFileSync without calling it.
    const code = stmt.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
    if (!/\b(readFileSync|readFile)\s*\(/.test(code)) continue;
    if (/\/\/ BOOT-READ-OK: \S/.test(lines[i - 1] ?? "")) continue;
    out.push({ file, line: i + 1, what: "reads a file when the module loads" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:no-file-reads-at-module-load - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("embed it (see scripts/embed-install-script.mjs) or read it inside the handler; a deliberate boot read says // BOOT-READ-OK: <why> above it");
  process.exit(1);
}
console.log(`lint:no-file-reads-at-module-load OK`);
