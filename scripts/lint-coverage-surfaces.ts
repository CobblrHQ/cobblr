#!/usr/bin/env tsx
// Every page, entity kind and user-facing action the registries name has a row in the coverage matrix.
//
// THE RULE. scripts/coverage-matrix/surfaces.generated.json is exactly what
// scripts/gen-coverage-surfaces.ts derives from the tree today (the web
// router, each module's own router, the manifests' kinds and actions, the
// foundational allowlist, the fundamentals walks' areas). A page, kind or
// action added without regenerating it would never appear in the matrix, and
// "never tested" would not even be on the page. merge-pr regenerates the file
// on the merge tree (scripts/lib/generated-files.mjs), so a stale copy never
// lands. No opt-out: regenerate.
//
// And every `// COVERAGE: <surface or glob> <dimension>` claim a test file
// makes (scripts/lib/coverage-annotations.mjs) must name a row and a
// dimension that applies to it: a typo there would otherwise record a passing
// test as coverage of nothing, or of the wrong page.
//
//   npx tsx scripts/lint-coverage-surfaces.ts   (pnpm lint coverage-surfaces)
import { existsSync, readFileSync } from "node:fs";
import { OUT, generate } from "./gen-coverage-surfaces.ts";
import { claimsIn, expandClaims } from "./lib/coverage-annotations.mjs";
import { repoFiles } from "./lib/repo-files.ts";

const count = (s: string) => {
  try {
    return (JSON.parse(s) as { surfaces: unknown[] }).surfaces.length;
  } catch {
    return 0;
  }
};

async function main(): Promise<void> {
  const want = await generate();
  const have = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (have !== want) {
    console.error(`lint:coverage-surfaces - ${OUT} has ${count(have)} rows; the registries give ${count(want)}. A page, kind or action changed without its matrix row.`);
    console.error("npx tsx scripts/gen-coverage-surfaces.ts");
    process.exit(1);
  }
  const rows = JSON.parse(want) as { dimensions: Array<{ id: string }>; surfaces: Array<{ id: string; applicable?: string[] }> };
  const problems: string[] = [];
  let claims = 0;
  for (const f of repoFiles(["*.test.ts", "*.test.tsx", "*.test.mjs"])) {
    if (f.startsWith("scripts/lib/coverage-")) continue; // the claims' own tests quote bad claims on purpose
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (!src.includes("COVERAGE:")) continue;
    const c = claimsIn(src);
    claims += c.length;
    for (const p of expandClaims(c, rows).problems) problems.push(`${f}: ${p}`);
  }
  if (problems.length) {
    console.error(`lint:coverage-surfaces - ${problems.length} test coverage claim(s) that name nothing:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("A claim is `// COVERAGE: <surface or glob> <dimension>[,<dimension>]`; find a row with node scripts/coverage-attest.mjs --list <text>.");
    process.exit(1);
  }
  console.log(`lint:coverage-surfaces OK (${count(want)} surfaces, ${claims} test claim(s))`);
}
void main();
