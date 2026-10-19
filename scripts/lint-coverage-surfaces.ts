#!/usr/bin/env tsx
// Every page, entity kind and user-facing action the registries name has a row in the coverage matrix.
//
// THE RULE. The matrix's rows are what scripts/gen-coverage-surfaces.ts derives from the tree today (the
// web router, each module's own router, the manifests' kinds and actions, the foundational allowlist, the
// fundamentals walks' areas), made fresh by whoever reads them; no committed copy can go stale (2026-10-19).
//
// And every `// COVERAGE: <surface or glob> <dimension>` claim a test file
// makes (scripts/lib/coverage-annotations.mjs) must name a row and a
// dimension that applies to it: a typo there would otherwise record a passing
// test as coverage of nothing, or of the wrong page.
//
// And a fundamentals walk's `covers` (a check's name, and the rows it proves
// in the nightly's fresh and volume workspaces) must name rows that exist and
// a check the walk makes: a name spelled once, only in covers, is a check
// that never runs, and the night records the action failed for it.
//
//   npx tsx scripts/lint-coverage-surfaces.ts   (pnpm lint coverage-surfaces)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generate } from "./gen-coverage-surfaces.ts";
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
  // The rows are made here, never read from a committed copy (gen-coverage-surfaces.ts says why).
  const want = await generate();
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
  let covered = 0;
  for (const f of readdirSync("e2e").filter((n) => /^fundamentals-.+-walk\.mjs$/.test(n)).sort()) {
    const file = join("e2e", f);
    const walk = (await import(pathToFileURL(join(process.cwd(), file)).href)) as { covers?: Record<string, string[]> };
    const src = readFileSync(file, "utf8");
    for (const [name, surfaces] of Object.entries(walk.covers ?? {})) {
      covered++;
      if (src.split(JSON.stringify(name)).length - 1 < 2) problems.push(`${file}: covers names the check "${name}", which the walk never makes (spell it the same in checks)`);
      for (const id of surfaces) {
        const row = rows.surfaces.find((r) => r.id === id);
        if (!row) problems.push(`${file}: covers names "${id}", which is no row`);
        else if (row.applicable && !row.applicable.some((d) => d === "fresh" || d === "volume")) problems.push(`${file}: "${id}" has no fresh or volume column for a night to fill`);
      }
    }
  }
  if (problems.length) {
    console.error(`lint:coverage-surfaces - ${problems.length} coverage claim(s) that name nothing:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("A claim is `// COVERAGE: <surface or glob> <dimension>[,<dimension>]`; find a row with node scripts/coverage-attest.mjs --list <text>.");
    process.exit(1);
  }
  console.log(`lint:coverage-surfaces OK (${count(want)} surfaces, ${claims} test claim(s), ${covered} walk check(s) covering rows)`);
}
void main();
