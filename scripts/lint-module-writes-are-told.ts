#!/usr/bin/env tsx
// A module's UI that sends a write with its own fetch tells noteWorkspaceWrite (@cobblr/platform-web), so every view the write could move refreshes.
//
// THE BUG THIS PREVENTS. #4431/#4440: Use some left the item's stock total stale and Move everything left a shelf's bin counter and Stock here showing what had gone; module clients fetched for themselves and no listener heard their writes
//
// THE RULE. A file under modules/*/src/ui that calls fetch() and names a
// mutating method (POST, PATCH, PUT, DELETE) must call noteWorkspaceWrite.
// The web app's own client already does, in one place; a module's client
// that fetches for itself is the door the writes walked around. A fetch
// that writes nothing any workspace view shows (a preview, a dry run) says
// so on the line or within three above: `// write-not-told: <why>`.
//
// THE BOUNDARY. A file that only reads (GETs) is not a write. Read at file
// level, not per call: a client funnels its writes through one request
// method, and that method is where the call belongs.
//
//   npx tsx scripts/lint-module-writes-are-told.ts   (pnpm lint module-writes-are-told)
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
  if (!/\/src\/ui\//.test(file)) return [];
  if (!/\bfetch\(/.test(src)) return [];
  const mutating = /["'`](POST|PATCH|PUT|DELETE)["'`]|\bmethod\s*[,:}]/.test(src);
  if (!mutating || /\bnoteWorkspaceWrite\(/.test(src)) return [];
  const lines = src.split("\n");
  const at = lines.findIndex((l) => /\bfetch\(/.test(l));
  if (lines.slice(Math.max(0, at - 3), at + 1).some((l) => /write-not-told:\s*\S/.test(l))) return [];
  return [{ file, line: at + 1, what: "writes with its own fetch and never tells noteWorkspaceWrite" }];
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:module-writes-are-told - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("After a successful mutating fetch call noteWorkspaceWrite(url); a fetch that writes nothing a workspace view shows says so: // write-not-told: <why>");
  process.exit(1);
}
console.log(`lint:module-writes-are-told OK`);
