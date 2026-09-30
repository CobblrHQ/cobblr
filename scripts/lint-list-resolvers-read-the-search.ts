#!/usr/bin/env tsx
// A list resolver reads the search words it is given (query.q), or says in a NO-TEXT-SEARCH line why it cannot, because one that ignores them answers every search with rows that do not match.
//
// THE BUG THIS PREVENTS. knowledge, tracking, builds and sales answered every search with up to ten unrelated rows each (2026-09-29, #4115)
//
// THE RULE. Every callback handed to registerListResolver or
// registerInstanceListResolver either reads the search words (`query.q`, or
// `textSearchWhere`, which takes them), hands the whole `query` on to another
// function (which this cannot see into, so it is trusted), or carries a
// `// NO-TEXT-SEARCH: <why>` line inside it or just above the call. Search
// (core-search, the palette, the assistant's search_records) asks every kind
// the same question through these; a resolver that drops `q` returns its
// first page as though every row matched.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A resolver that delegates
// (`listParts(orgId, query)`) reads q somewhere this lint cannot follow; the
// inventory and purchases resolvers do exactly that and search correctly, so
// passing `query` whole is a pass rather than a violation. A resolver that
// only reads `query.limit` or `query.filter` is not delegating.
//
// PROVED RED on the five resolvers named above before they were fixed.
//
//   npx tsx scripts/lint-list-resolvers-read-the-search.ts   (pnpm lint list-resolvers-read-the-search)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules", "api/src"];

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

/** The text of a call from its opening paren to the matching close. */
function callBody(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const re = /register(?:Instance)?ListResolver\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    const body = callBody(src, open);
    // The declaration itself (`registerListResolver(kind: string, ...)`), not a call.
    if (/^\(\s*\w+\s*:\s*string/.test(body)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const above = src.split("\n").slice(Math.max(0, line - 4), line - 1).join("\n");
    if (/NO-TEXT-SEARCH: \S/.test(body) || /NO-TEXT-SEARCH: \S/.test(above)) continue;
    if (/\bquery\.q\b|\btextSearchWhere\b|\{[^}]*\bq\b[^}]*\}\s*=\s*query\b/.test(body)) continue;
    // Past the callback's own parameter list: does it hand `query` on whole?
    const arrow = body.indexOf("=>");
    if (arrow >= 0 && /[(,]\s*query\s*[,)]/.test(body.slice(arrow))) continue;
    out.push({ file, line, what: "a list resolver that never reads the search words (query.q); every search gets its first page" });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:list-resolvers-read-the-search - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:list-resolvers-read-the-search OK`);
