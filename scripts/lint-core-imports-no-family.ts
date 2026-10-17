#!/usr/bin/env tsx
// A module's core never imports one of its families: only src/module.ts may import families/manifests.ts and only src/api/index.ts and the boot may import families/index.ts.
//
// THE BUG THIS PREVENTS. 2026-10-17: digifab's families seam (#6943); the owner asked for families that break out separately at the lower level
//
// THE RULE. A file of modules/<m>/src outside families/ (the core) imports
// nothing under families/, with two exceptions that are the seam itself:
// src/module.ts reads families/manifests.ts (the manifest pieces), and
// src/api/index.ts and src/module.ts's boot read families/index.ts (the
// registrations). Test files are not judged.
//
// THE BOUNDARY. Relative imports inside the module only; another module is
// lint:isolation's. The files directly in families/ are the lists of
// families, and are not the core.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-core-imports-no-family.ts   (pnpm lint core-imports-no-family)
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
  if (!here || here.family || here.root) return out;
  for (const { spec, line } of relativeImports(src)) {
    const to = placeOf(target(file, spec));
    if (!to || to.module !== here.module || !to.rel.startsWith("families/")) continue;
    if (here.rel === "module.ts" && to.rel === "families/manifests.ts") continue;
    if ((here.rel === "api/index.ts" || here.rel === "module.ts") && to.rel === "families/index.ts") continue;
    out.push({ file, line, what: `the core imports ${to.rel}: a family declares itself through families/index.ts and families/manifests.ts, read only by src/api/index.ts and src/module.ts` });
  }
  return out;
}

const violations: Violation[] = [];
// The pre-push run hands a per-file lint only the change's files (lib/lint-only-files.ts); CI checks the whole tree.
for (const root of ROOTS) for (const file of walk(root)) if (onlyChanged(file)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:core-imports-no-family - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Fix the violation; a genuine exception opts out with an annotation that carries its reason.");
  process.exit(1);
}
console.log(`lint:core-imports-no-family OK`);
