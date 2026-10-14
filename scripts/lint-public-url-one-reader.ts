#!/usr/bin/env tsx
// This instance's public address is read in one place, publicBaseUrl in @cobblr/platform-contract/public-url, under one name.
//
// THE BUG THIS PREVENTS. PUBLIC_BASE_URL was read four times under two names, and two readers did not know the second (#3499)
//
// THE RULE. Outside packages/platform-contract/src/public-url.ts, no code reads
// `PUBLIC_BASE_URL` from the environment (`process.env.PUBLIC_BASE_URL`, or
// through a parsed `env` object), and nothing names `COBBLR_PUBLIC_URL`, the
// alias that was deleted. Comments are stripped first, so a sentence about the
// variable is not a read. Tests are out of scope: they set it, they do not
// resolve it. There is no opt-out; a second reader is the bug.
//
//   npx tsx scripts/lint-public-url-one-reader.ts   (pnpm run lint:public-url-one-reader)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./lib/source-scan.ts";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src", "modules", "packages", "web/src"];

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
const OWNER = "packages/platform-contract/src/public-url.ts";
const READ = /\b(?:process\.env|env)\.PUBLIC_BASE_URL\b|\bprocess\.env\[\s*["']PUBLIC_BASE_URL["']\s*\]|\bCOBBLR_PUBLIC_URL\b/;

function check(file: string, src: string): Violation[] {
  if (file === OWNER) return [];
  const out: Violation[] = [];
  const lines = stripComments(src).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = READ.exec(lines[i] ?? "");
    if (m) out.push({ file, line: i + 1, what: `reads the public address itself (\`${m[0]}\`)` });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:public-url-one-reader - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Import publicBaseUrl from @cobblr/platform-contract/public-url.");
  process.exit(1);
}
console.log(`lint:public-url-one-reader OK`);
