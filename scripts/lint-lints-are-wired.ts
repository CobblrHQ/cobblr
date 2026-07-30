#!/usr/bin/env tsx
// Every lint:* script must actually be RUN by something.
//
// WHY THIS IS A LINT: a check nothing invokes is not a guardrail, it is a file.
// It costs the same to write, reads the same in a PR ("shipped the fix AND the
// lint"), and catches exactly nothing. Two were found orphaned on 2026-07-30 -
// including `lint:scan-row-title`, added that same day and described in its own
// PR as the thing that "forces every response through withTitle()". It had never
// executed once.
//
// So the wiring is checked mechanically: a lint:* script in package.json must
// appear in .forgejo/workflows/ci.yml or in the pre-push hook, or be listed
// below as deliberately manual WITH a reason.
//
//   npx tsx scripts/lint-lints-are-wired.ts   (npm run lint:lints-are-wired)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lints that are deliberately NOT in CI. Each needs a reason - "we never got
 * round to it" is not one, and an entry here is a standing invitation to argue.
 */
const MANUAL: Record<string, string> = {
  "lint:pdf-bench":
    "renders PDFs and compares ink coverage, so its baseline is font- and " +
    "renderer-sensitive; in CI it would report label regressions that are really " +
    "container font differences. Run it locally when changing label layout.",
};

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(join(ROOT, ".forgejo", "workflows", "ci.yml"), "utf8");
const hook = readFileSync(join(ROOT, "scripts", "git-hooks", "pre-push"), "utf8");

const lints = Object.keys(pkg.scripts).filter((s) => s.startsWith("lint:"));
const orphans: string[] = [];
for (const l of lints) {
  if (l in MANUAL) continue;
  // Word-boundary match so `lint:scan-row` does not "find" `lint:scan-row-title`.
  const re = new RegExp(`${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:-])`);
  if (!re.test(ci) && !re.test(hook)) orphans.push(l);
}

// A stale allowlist is its own rot: an entry for a lint that no longer exists
// hides the fact that nobody re-checked the list.
const stale = Object.keys(MANUAL).filter((m) => !lints.includes(m));

if (orphans.length === 0 && stale.length === 0) {
  console.log(
    `[lint:lints-are-wired] ✓ all ${lints.length} lint scripts run in CI or pre-push ` +
      `(${Object.keys(MANUAL).length} deliberately manual).`,
  );
  process.exit(0);
}

if (orphans.length) {
  console.error(
    `\n[lint:lints-are-wired] ✗ ${orphans.length} lint script(s) are never run, so they guard nothing:\n`,
  );
  for (const o of orphans) console.error(`  - ${o}`);
  console.error(
    `\nAdd a step to .forgejo/workflows/ci.yml:\n\n` +
      `      - name: <what it protects>\n` +
      `        run: |\n` +
      `          set -o pipefail\n` +
      `          pnpm run ${orphans[0]} 2>&1 | tee -a /tmp/typecheck.out\n\n` +
      `...or add it to scripts/git-hooks/pre-push, or list it in MANUAL in this file with a reason.\n`,
  );
}
if (stale.length) {
  console.error(`\n[lint:lints-are-wired] ✗ MANUAL lists ${stale.length} lint(s) that no longer exist:\n`);
  for (const s of stale) console.error(`  - ${s}`);
  console.error("\nRemove them from MANUAL in scripts/lint-lints-are-wired.ts.\n");
}
process.exit(1);
