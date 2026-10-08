#!/usr/bin/env tsx
// A query that can be switched off is never waited on with isPending, which stays true forever while it is off; wait on isLoading, or say why waiting forever is right.
//
// THE BUG THIS PREVENTS. A guest's app never finished booting on staging (2026-10-08): the workspace currency query was switched off for guests and the boot screen waited on its isPending.
//
// THE RULE. A `const x = useQuery({ ... })` whose options carry an `enabled:`
// that is not literally `true` can be switched off. While it is off, TanStack
// reports `isPending` true and never fetches, so `x.isPending` read anywhere in
// the same file fails; `x.isLoading` (pending AND fetching) passes. A wait that
// is right to last for as long as the query is off says so on the line or in
// the three lines above: `// pending-ok: <why>`. Mutations are untouched:
// `useMutation` has no `enabled`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. The bundle update button
// waits on its preview's isPending on purpose: an update pressed before the
// conflicts are known would apply without the person's answers, and the
// preview is on whenever that button is offered. That is the pending-ok case,
// not a reason to exempt the file.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-pending-query-never-gates.ts   (pnpm lint pending-query-never-gates)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages"];

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
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*useQuery(?:<[^>]*>)?\(\s*\{/g)) {
    const name = m[1]!;
    let depth = 0;
    let end = src.length;
    for (let i = m.index! + m[0].length - 1; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const options = src.slice(m.index!, end);
    if (!/\benabled\s*:/.test(options) || /\benabled\s*:\s*true\b/.test(options)) continue;
    for (const use of src.matchAll(new RegExp(`\\b${name}\\.isPending\\b`, "g"))) {
      const line = src.slice(0, use.index).split("\n").length;
      const near = lines.slice(Math.max(0, line - 4), line).join("\n");
      if (/\/\/\s*pending-ok:\s*\S/.test(near)) continue;
      out.push({ file, line, what: `${name}.isPending on a query that can be switched off (it stays pending while off)` });
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:pending-query-never-gates - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Use isLoading (pending and fetching), or mark the line // pending-ok: <why>.");
  process.exit(1);
}
console.log(`lint:pending-query-never-gates OK`);
