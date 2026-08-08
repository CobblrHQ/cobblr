// Staged docs that can never publish.
//
// `docs-flush.mjs` only walks entries with `type: feature` — deliberate, and
// documented in design-decisions/staged-docs-pipeline.md. So a `## docs`
// section on an `improvement` or a `fix`, however carefully written and however
// precise its `docs_target`, is never read by anything. It looks staged. It is
// dead.
//
// Three of them were found this way (2026-08-08): fields-yours-first,
// location-chip-picker and settings-one-header each named a real USER_GUIDE
// section and sat there. None of that prose had reached the manual, and nothing
// said so — `docs-flush --dry-run` printed "nothing to publish", which was true
// and completely unhelpful. The authors believed they had staged docs.
//
// The rule this enforces: a `## docs` section, or a `docs_target` naming a real
// path, belongs only on a `type: feature` entry. Anything else documents
// in-commit instead, which is what the `none (documented in USER_GUIDE.md in
// this commit)` idiom already says across the rest of changelog.d.
//
// Run: npx tsx scripts/lint-staged-docs-reachable.ts

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = "changelog.d";

if (!existsSync(DIR)) {
  console.log("✓ staged-docs-reachable lint: no changelog.d — nothing to check");
  process.exit(0);
}

const failures: string[] = [];
let checked = 0;

for (const name of readdirSync(DIR).sort()) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  const path = join(DIR, name);
  const raw = readFileSync(path, "utf8");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const isFeature = /^type:\s*feature\s*$/m.test(fm);
  if (isFeature) {
    checked++;
    continue;
  }

  const target = fm.match(/^docs_target:\s*(.+)$/m)?.[1]?.trim();
  // `none (<reason>)` is the explicit opt-out and is fine on any type.
  const claimsTarget = !!target && !/^none\s*\(/.test(target);
  const hasDocsBody = !!raw.split(/^## docs\s*$/m)[1]?.trim();

  if (claimsTarget || hasDocsBody) {
    const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim() ?? "(none)";
    failures.push(
      `${path}: type is \`${type}\`, but it ${
        claimsTarget ? `names docs_target \`${target}\`` : "carries a `## docs` section"
      }. docs-flush only walks \`type: feature\`, so this never publishes and the ` +
        `prose silently never reaches the docs. Either make it a feature, or write ` +
        `the docs in this commit and set \`docs_target: none (<reason>)\`.`,
    );
  }
}

if (failures.length) {
  console.error("✗ lint-staged-docs-reachable: staged docs that can never publish:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`✓ staged-docs-reachable lint: ${checked} feature entr(ies) stage docs reachably`);
process.exit(0);
