#!/usr/bin/env tsx
// ci-main.yml is exactly what ci.yml generates, so main's lane can never drift from the pull-request gate.
//
// THE BUG THIS PREVENTS. 2026-09-30: main's own typecheck and test waited
// behind a 150-job pull-request queue on the labels they shared, and the 04:00
// release found no green main commit and nearly skipped a day carrying two
// security fixes. Main's pushes now run ci-main.yml on labels only they use.
// A second copy of a 1,200-line workflow kept by hand is how the gate and its
// copy stop testing the same thing, so the copy is generated
// (scripts/gen-ci-main.mjs) and this refuses a stale or hand-edited one.
//
// THE RULE. The committed ci-main.yml equals generate(ci.yml): ci.yml's jobs
// with runs-on light -> light-main and ci-test -> ci-main, a push-to-main
// trigger with ci.yml's pull_request paths-ignore, and a per-commit group.
// It also refuses a ci.yml that triggers on push again (main would run twice,
// once on the shared queue) or a job on a label with no main lane. No
// opt-out: regenerate. merge-pr regenerates it on the merge tree
// (scripts/lib/generated-files.mjs).
//
//   npx tsx scripts/lint-ci-main-generated.ts   (pnpm lint ci-main-generated)
import { readFileSync } from "node:fs";
import { generate } from "./gen-ci-main.mjs";

let want: string;
try {
  want = generate(readFileSync(".forgejo/workflows/ci.yml", "utf8"));
} catch (e) {
  console.error(`lint:ci-main-generated - ${(e as Error).message}`);
  process.exit(1);
}
let have = "";
try {
  have = readFileSync(".forgejo/workflows/ci-main.yml", "utf8");
} catch {}
if (have !== want) {
  console.error("lint:ci-main-generated - .forgejo/workflows/ci-main.yml is not what ci.yml generates (edited by hand, or ci.yml changed since).");
  console.error("node scripts/gen-ci-main.mjs");
  process.exit(1);
}
console.log("lint:ci-main-generated OK (ci-main.yml is ci.yml on main's lane)");
