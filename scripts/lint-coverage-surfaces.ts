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
//   npx tsx scripts/lint-coverage-surfaces.ts   (pnpm lint coverage-surfaces)
import { existsSync, readFileSync } from "node:fs";
import { OUT, generate } from "./gen-coverage-surfaces.ts";

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
  console.log(`lint:coverage-surfaces OK (${count(want)} surfaces)`);
}
void main();
