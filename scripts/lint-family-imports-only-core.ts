#!/usr/bin/env tsx
// A module's family imports only its own folder, its module's core and packages, never another family or another module.
//
// THE BUG THIS PREVENTS. 2026-10-17: digifab's families seam (#6943)
//
// THE RULE. A file of modules/<m>/src/families/<f>/ imports only its own
// family's files and the module's core (anything in src/ outside families/),
// relatively, plus packages. Never another family, never the lists of
// families (families/index.ts, manifests.ts), never another module by path.
// Test files are not judged.
//
// THE BOUNDARY. Package imports (@cobblr/platform-contract, zod, express)
// are fine and lint:isolation already holds cross-module ones.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-family-imports-only-core.ts   (pnpm lint family-imports-only-core)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";
import { onlyChanged } from "./lib/lint-only-files.ts";
import { placeOf, relativeImports, target } from "./lib/module-families.ts";

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
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const here = placeOf(file);
  if (!here || !here.family) return out;
  for (const { spec, line } of relativeImports(src)) {
    const path = target(file, spec), to = placeOf(path);
    if (!to || to.module !== here.module) { out.push({ file, line, what: `the ${here.family} family reaches outside its module (${path})` }); continue; }
    if (to.family && to.family !== here.family) out.push({ file, line, what: `the ${here.family} family imports the ${to.family} family (${to.rel}): families share only the core` });
    else if (to.root) out.push({ file, line, what: `the ${here.family} family imports ${to.rel}, the module's list of families` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:family-imports-only-core - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:family-imports-only-core OK`);
