#!/usr/bin/env tsx
// A module's list route that cuts its rows at a fixed number answers through pagedAnswer, so the caller learns how many there are and can reach the rest.
//
// THE BUG THIS PREVENTS. The assets page read 500 of 500 with 520 assets on file: the list route cut at 500 and said nothing, so 20 assets could not be reached (fundamentals audit, 2026-09-29).
//
// THE RULE. In a module's api, a GET route on a path with no `:param` (a
// collection: "/", "/entries", "/sheets/imports") whose handler ends its query
// with `.limit(<number>)` answers through `pagedAnswer`
// from @cobblr/platform-contract/list-page, which returns the page, the
// collection's `total` and whether the page reaches the end. Passes: the
// handler mentions pagedAnswer. Fails: a literal cap and no pagedAnswer. A
// route whose cap is the answer (a "latest 20" feed) says so on the line above
// the limit: `// list-cap-ok: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. It first read "/" only,
// because every GET path without a `:param` caught 18 routes, most of them
// feeds whose cap IS the answer (recent imports, the latest changes), and a
// rule argued with at every feed stops being read. That left knowledge's
// `/entries` answering its newest 500 and nothing else, unseen (#4134). So it
// reads every such path, and each feed says why its cap is the answer on the
// line above the limit; a list still waiting to be converted says
// `list-cap-ok: not paged yet, #4134`. A `.limit(1)` is one row ("the latest
// plan"), not a list. A limit read from the request is a page the caller
// chose; sub-routes (`/:id/units`) list a record's parts.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-list-route-says-total.ts   (pnpm lint list-route-says-total)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["modules"];

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
  if (!/\/src\/api\//.test(file)) return out;
  // Each `.get(` whose first argument is a path with no `:param` starts a
  // collection handler; it runs to the next router verb. The path may sit on
  // the line after `.get(`.
  const starts = [...src.matchAll(/^[A-Za-z_]\w*\.get\(\s*"\/[^":]*"\s*,/gm)].map((m) => m.index!);
  for (const start of starts) {
    const rest = src.slice(start + 5);
    const next = rest.search(/\n[A-Za-z_]\w*\.(get|post|patch|put|delete|use)\(/);
    const body = next === -1 ? rest : rest.slice(0, next);
    if (body.includes("pagedAnswer")) continue;
    const cap = /\.limit\(\s*(?!1\s*\))\d+\s*\)/.exec(body);
    if (!cap) continue;
    const at = start + 5 + cap.index;
    const line = src.slice(0, at).split("\n").length;
    if (/\/\/ list-cap-ok: \S/.test(src.split("\n")[line - 2] ?? "")) continue;
    out.push({ file, line, what: `the list route cuts at ${cap[0].slice(7, -1).trim()} and never says how many there are; answer through pagedAnswer (@cobblr/platform-contract/list-page)` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:list-route-says-total - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:list-route-says-total OK`);
