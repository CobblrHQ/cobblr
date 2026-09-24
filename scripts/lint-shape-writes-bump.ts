#!/usr/bin/env tsx
// A write that changes a workspace's shape (modules on, collections, bundles) bumps its shape version, so an open app refetches its menu and destinations; a write that does not change the shape says why.
//
// THE BUG THIS PREVENTS. a receipt filing installed two apps and the phone's menu showed neither until a reload (#3582)
//
// THE RULE, per write site. A statement that inserts into, updates or deletes
// from `org_modules`, `workspace_module_instances` or `bundles` (the tables a
// workspace's menu, filing destinations and installed apps are read from) sits
// in a function that also calls `bumpWorkspaceShape(`. A write that does not
// change what a person can see (a migration counter on org_modules) carries
// `// SHAPE-UNCHANGED: <why>` on the line above it, and the reason is the
// review. The function is the top-level `function` the write sits in, which is
// where the bump belongs: after the write, before the answer.
//
//   npx tsx scripts/lint-shape-writes-bump.ts   (pnpm lint shape-writes-bump)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

const WRITE = /\b(insertInto|updateTable|deleteFrom)\(\s*"(org_modules|workspace_module_instances|bundles)"/g;
const FN_START = /^(export\s+)?(async\s+)?function\s+\w+/;
const REASON = /SHAPE-UNCHANGED:\s*\S/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (file.endsWith("workspace-shape.ts")) return [];
  const out: Violation[] = [];
  const lines = src.split("\n");
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  for (const m of src.matchAll(WRITE)) {
    const at = lineOf(m.index ?? 0);
    // A kysely chain starts a line or two above the table name.
    const above = lines.slice(Math.max(0, at - 5), at).join("\n");
    if (REASON.test(above)) continue;
    let from = at - 1;
    while (from > 0 && !FN_START.test(lines[from] ?? "")) from--;
    let to = at;
    while (to < lines.length && !FN_START.test(lines[to] ?? "")) to++;
    const body = lines.slice(from, to).join("\n");
    if (/\bbumpWorkspaceShape\(/.test(body)) continue;
    out.push({ file, line: at, what: `${m[1]}("${m[2]}") in a function that never bumps the workspace shape` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:shape-writes-bump - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("await bumpWorkspaceShape(orgId) after the write (api/src/platform/workspace-shape.ts), or // SHAPE-UNCHANGED: <why> on the write");
  process.exit(1);
}
console.log(`lint:shape-writes-bump OK`);
