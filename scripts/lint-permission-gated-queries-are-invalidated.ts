#!/usr/bin/env tsx
// A query whose enabled gate names a permission (admin, a role, may…, can…, a watcher) is never refetched by hand: an explicit refetch runs the query its own gate disables, so a person without that permission meets a refusal; the page invalidates it instead.
//
// THE BUG THIS PREVENTS. #7509 (2026-10-19): an operator's embroidery Start refreshed the page and refetched the admin-only station list, two 403s every refresh
//
// THE RULE. In a file under web/src or packages/platform-web/src, a
// `const x = useQuery({ ... })` whose `enabled:` names a permission (admin,
// isAdmin, a role or roleSatisfies, may..., can<Thing>, a watcher, an operator,
// an owner) is never called as `x.refetch(`. react-query's refetch runs a query
// whatever its gate says; invalidateQueries refetches only the queries this
// person's page has enabled. A refetch that is genuinely safe (it only renders
// where the gate already holds) says so on its line: `// refetch-ok: <why>`.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. 42 hand refetches of a gated
// query were in the tree when this was written; 39 gate on data being there
// (a slug, an id, an open sheet), where a refetch is the retry the person asked
// for and asks for nothing they may not see. Only a gate on who the person is
// turns a refetch into a refused request, so only those are judged: the
// embroidery station list (admin), the assistant's model list (mayRead) and a
// detector's cameras and printers (isWatcher).
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-permission-gated-queries-are-invalidated.ts   (pnpm lint permission-gated-queries-are-invalidated)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "packages/platform-web/src"];

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** A gate on who the person is, not on whether the data is there. */
const PERMISSION = /\b(?:admin|isAdmin|role|roleSatisfies|may[A-Z]?\w*|can[A-Z]\w*|isWatcher|isOperator|operator|owner)\b/;
const QUERY = /const\s+(\w+)\s*=\s*useQuery(?:<[^>]*>)?\(\s*\{/g;

/** The check. Return every violation in one file; an empty array is a pass. */
export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const gated = new Map<string, string>();
  for (const m of src.matchAll(QUERY)) {
    let depth = 1, i = m.index! + m[0].length;
    while (i < src.length && depth) { const c = src[i++]; if (c === "{") depth++; else if (c === "}") depth--; }
    const enabled = src.slice(m.index!, i).match(/\benabled:\s*([^,\n}]+)/)?.[1]?.trim();
    if (enabled && PERMISSION.test(enabled)) gated.set(m[1]!, enabled);
  }
  if (!gated.size) return out;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/\/\/ refetch-ok: \S/.test(line)) continue;
    for (const [name, enabled] of gated) {
      if (new RegExp(`\\b${name}\\.refetch\\(`).test(line)) out.push({ file, line: i + 1, what: `${name}.refetch() runs a query gated on "${enabled}" for someone the gate shuts out` });
    }
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:permission-gated-queries-are-invalidated - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("queryClient.invalidateQueries({ queryKey }) refetches only the queries this person's page has enabled");
  process.exit(1);
}
console.log(`lint:permission-gated-queries-are-invalidated OK`);
