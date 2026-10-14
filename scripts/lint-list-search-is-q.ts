#!/usr/bin/env tsx
// A route's query schema that takes a search word takes it as q (search, term or query only beside q), the name every list and the workspace search read.
//
// THE BUG THIS PREVENTS. the parts list took only ?search= and dropped ?q=, so ?q= listed every part and the nightly walk seeded nothing (2026-10-03, #4410)
//
// THE RULE. In a route file (api/src/routes, modules/*/src/api), a zod object
// with a string key `search`, `term` or `query` also has a `q` key. A zod
// object strips keys it does not declare, silently, so a list that knows only
// `search` answers `?q=` with everything, and nothing says so. Passes: `q`
// alone, or `q` beside an alias. Opts out: `// SEARCH-PARAM-OK: <why>` on the
// key's line (a body field that is not a search word, say).
//
// THE BOUNDARY. Only string-typed keys: a saved view's `query` is an object
// (core-views), not a search word, and is not judged. Only route files: a
// request BODY schema elsewhere is not a list's query string.
//
//   npx tsx scripts/lint-list-search-is-q.ts   (pnpm lint list-search-is-q)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/routes", "modules"];

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
  if (file.startsWith("modules/") && !/\/src\/api\//.test(file)) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/z\.object\(\{\s*$/.test(lines[i] ?? "")) continue;
    // The object's own keys: one level in from where it opened, up to its close.
    const indent = (lines[i]!.match(/^\s*/)?.[0].length ?? 0);
    const keys: Array<{ key: string; line: number; text: string }> = [];
    let keyIndent = -1;
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k] ?? "";
      const lead = l.match(/^\s*/)?.[0].length ?? 0;
      if (/^\s*\}\)/.test(l) && lead <= indent + 2 && lead >= indent) break;
      const m = /^(\s*)([A-Za-z_]+)\s*:\s*(.*)$/.exec(l);
      if (!m) continue;
      if (keyIndent < 0) keyIndent = m[1]!.length;
      if (m[1]!.length !== keyIndent) continue;
      keys.push({ key: m[2]!, line: k + 1, text: m[3]! });
    }
    const hasQ = keys.some((k) => k.key === "q");
    for (const k of keys) {
      if (!["search", "term", "query"].includes(k.key) || !/^z\.(coerce\.)?string\(/.test(k.text)) continue;
      if (hasQ || /SEARCH-PARAM-OK: \S/.test(lines[k.line - 1] ?? "")) continue;
      out.push({ file, line: k.line, what: `takes its search word as \`${k.key}\` with no \`q\`: ?q= would be dropped silently and list everything` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:list-search-is-q - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:list-search-is-q OK`);
