#!/usr/bin/env tsx
// A string a person reads from the api names the product through productName(), never the literal Cobblr, because one engine runs more than one product.
//
// THE BUG THIS PREVENTS. A second product's server mailed its owner 'Reset your Cobblr password' (#6815, 2026-10-15).
//
// THE RULE. A string literal ("...", '...' or `...`) on a code line in
// api/src/platform or api/src/routes that holds the word Cobblr counts. A file
// may carry no more of them than scripts/product-name-baseline.json records
// for it, and a file it does not list carries none. The baseline only shrinks:
// `--update` lowers each file's count to what it now holds and drops files
// that reached zero; it never raises one or adds a file. A string that must
// say Cobblr whatever the server is (the identity service's own account, a
// managed app called "Cobblr for Yarn", the "Cobblr Receipts" address name)
// says why on its line or the line above: // PRODUCT-NAME: <why>.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. Comments are not read: the
// files are full of prose about Cobblr the engine, which no person receives.
// Identifiers and env names (COBBLR_*, @cobblr/...) never match, the word is
// case-sensitive. The 194 strings that held it when this was written are the
// baseline, mostly federation and edge-bridge words between two Cobblr servers.
//
//   npx tsx scripts/lint-product-name-not-hard-coded.ts   (pnpm lint product-name-not-hard-coded)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["api/src/platform", "api/src/routes"];

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

const BASELINE_PATH = "scripts/product-name-baseline.json";
const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

/** Every literal naming the product on a code line, less those that say why. */
function literals(src: string): number[] {
  const out: number[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (/PRODUCT-NAME: \S/.test(line) || /PRODUCT-NAME: \S/.test(lines[i - 1] ?? "")) continue;
    if (/(["'`])(?:(?!\1)[^\\]|\\.)*\bCobblr\b(?:(?!\1)[^\\]|\\.)*\1/.test(line)) out.push(i + 1);
  }
  return out;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const found = literals(src);
  const allowed = baseline[file] ?? 0;
  if (found.length <= allowed) return [];
  return found.map((line) => ({ file, line, what: `names the product as the literal Cobblr (${found.length} in this file, ${allowed} allowed)` }));
}

const counts: Record<string, number> = {};
if (process.argv.includes("--update")) {
  for (const root of ROOTS) for (const file of walk(root)) counts[file] = literals(readFileSync(file, "utf8")).length;
  const next: Record<string, number> = {};
  for (const [file, was] of Object.entries(baseline).sort()) { const now = Math.min(was, counts[file] ?? 0); if (now > 0) next[file] = now; }
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log(`lint:product-name-not-hard-coded baseline: ${Object.values(next).reduce((a, b) => a + b, 0)} literal(s) in ${Object.keys(next).length} file(s)`);
  process.exit(0);
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:product-name-not-hard-coded - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Name the product with `${productName()}` from api/src/platform/product-name.ts, or say why it is always Cobblr: // PRODUCT-NAME: <why>");
  process.exit(1);
}
console.log(`lint:product-name-not-hard-coded OK`);
