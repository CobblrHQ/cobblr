#!/usr/bin/env tsx
/**
 * lint:ci-pr-any-base — the PR gate must not filter on the BASE branch.
 *
 * `pull_request: branches: [main]` reads like "PRs into main", and that is
 * exactly what it does: a PR opened against any other base fires no event, so
 * it gets NO checks. Nothing marks it red, because nothing ran. It looks like
 * CI is slow.
 *
 * That is the normal shape for stacked work here — a change that depends on an
 * unmerged branch is opened against that branch — so the hole is not exotic.
 * PR #2607 sat with zero statuses for forty minutes while unrelated runs
 * completed on the same box (2026-09-04).
 *
 * merge-pr.sh is the backstop and it holds: a head whose combined status is
 * 'none' is refused, so nothing merges unchecked. This lint is about getting
 * the evidence automatically instead of remembering to dispatch it by hand.
 *
 * A `paths-ignore:` filter is fine and stays; only a base-branch filter is
 * banned.
 */
import { readFileSync } from "node:fs";

const FILE = ".forgejo/workflows/ci.yml";
const src = readFileSync(new URL(`../${FILE}`, import.meta.url).pathname, "utf8");

// The pull_request block: from the key to the next top-level trigger key.
const m = src.match(/^ {2}pull_request:\n((?: {4}.*\n|\n)*)/m);
if (!m) {
  console.error(`[lint:ci-pr-any-base] ✗ ${FILE}: no pull_request trigger — the PR gate is gone entirely.`);
  process.exit(1);
}
const block = m[1] ?? "";
const filter = block.match(/^ {4}branches(?:-ignore)?:.*$/m);
if (filter) {
  console.error(`[lint:ci-pr-any-base] ✗ ${FILE}: the pull_request trigger filters on the base branch:`);
  console.error(`      ${filter[0].trim()}`);
  console.error(`  A branch filter on pull_request matches the BASE. With it, a PR stacked on another`);
  console.error(`  wt/* branch fires no event and gets NO checks — it reads as slow CI, not as red.`);
  console.error(`  Drop the filter. paths-ignore is fine. (merge-pr.sh still refuses a 'none' status.)`);
  process.exit(1);
}
console.log("[lint:ci-pr-any-base] ✓ the PR gate runs for a PR onto any base, stacked work included");
