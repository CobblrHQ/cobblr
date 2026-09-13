#!/usr/bin/env tsx
// A script that reaches the Forgejo API takes its base from forgejo_api_base (scripts/lib/forgejo-api.sh), never from the origin remote's transport URL.
//
// THE BUG THIS PREVENTS. open-pr.sh derived the API host from an ssh origin (forgejo.example:2222) and died with 'Name or service not known' on the first machine whose remote was ssh (2026-09-14).
//
// THE RULE. A shell script under scripts/ that both reads the origin remote
// (`remote get-url origin`) and builds a Forgejo API URL (`/api/v1`) must
// source scripts/lib/forgejo-api.sh and take the base from forgejo_api_base:
// the origin's transport URL names the git host, which on an ssh remote is
// not the API host and carries a port the API does not. The resolver itself
// is the one file allowed to read the remote for this.
//
//   npx tsx scripts/lint-forgejo-api-base.ts   (pnpm run lint:forgejo-api-base)
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
    else if (/\.sh$/.test(name)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (file.endsWith("lib/forgejo-api.sh")) return [];
  const readsOrigin = /remote get-url origin/.test(src);
  const reachesApi = /\/api\/v1/.test(src);
  if (!readsOrigin || !reachesApi) return [];
  if (/forgejo-api\.sh/.test(src) && /forgejo_api_base/.test(src)) return [];
  const line = src.split("\n").findIndex((l) => /remote get-url origin/.test(l)) + 1;
  return [{ file, line, what: "derives the Forgejo API host from the origin remote; source lib/forgejo-api.sh and use forgejo_api_base" }];
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:forgejo-api-base - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:forgejo-api-base OK`);
