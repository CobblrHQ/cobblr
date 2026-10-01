// Guard: CI runs on every pull request and every push to main, with no path
// filter, so every commit carries a CI status.
//
// A commit with NO status reads exactly like "CI never saw it": merge-pr.sh
// refuses it, and a watcher cannot tell "filtered" from "forgot to push". For
// a while ci.yml carried `paths-ignore` for docs and a second workflow
// (docs-only.yml, the inverse filter) existed only to post a green status for
// those commits: a second row in Actions on every pull request, and a pair of
// lists this lint used to hold in step. The selectors inside CI now skip what
// a change cannot reach (ci-typecheck-affected.sh, unit-affected.mjs,
// ci-affected.sh), so the filter and its twin are gone, and this lint keeps a
// filter from coming back on its own.
//
// On main it never saved anything either: `paths-ignore` matched nothing on
// a merge commit's tip, so every merge ran CI anyway.
// Run: node scripts/lint-ci-every-commit-has-a-status.ts

import { existsSync, readFileSync } from "node:fs";

const FILES = [".forgejo/workflows/ci.yml", ".forgejo/workflows/ci-main.yml"];
let bad = 0;
for (const f of FILES) {
  if (!existsSync(f)) {
    console.error(`ci-every-commit-has-a-status lint: ${f} is missing. If it was renamed, update this lint rather than deleting it.`);
    process.exit(1);
  }
  const src = readFileSync(f, "utf8");
  const head = src.slice(0, src.search(/^jobs:/m) >>> 0);
  head.split("\n").forEach((line, i) => {
    if (/^\s+(paths|paths-ignore):/.test(line)) {
      console.error(`  ${f}:${i + 1}: ${line.trim()}`);
      bad++;
    }
  });
}
if (bad) {
  console.error(
    `\nci-every-commit-has-a-status lint: a path filter on CI's trigger leaves some commits with no status,\n` +
      `  which merge-pr.sh and every watcher read as "CI never saw it". Skip inside the job instead\n` +
      `  (the affected selectors already skip what a change cannot reach).`,
  );
  process.exit(1);
}
console.log(`ci-every-commit-has-a-status lint: ${FILES.length} workflows trigger on every commit ✓`);
