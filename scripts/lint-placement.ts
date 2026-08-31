#!/usr/bin/env tsx
// The map stays true, or CI says so.
//
// scripts/placement-registry.ts answers "where does this go?" BEFORE the work,
// which is only worth having if the answer is current. A stale map is worse
// than none: it reads exactly like a true one. (Not hypothetical — two days
// ago a design record that had been right for eighteen days sent an agent to a
// wrong answer about the canary channel.)
//
// So every fact in the map is checkable, and this checks all of them:
//
//   1. every `dir` exists (allowing the <name> placeholder for per-module dirs);
//   2. every `exemplar` exists — the shape you are told to copy is a live file,
//      never a snippet pasted into the registry that nobody updates;
//   3. every lint a row names is a real script in package.json;
//   4. every NEW lint script is claimed by a row or declared GENERAL.
//
// (4) is the one that keeps the map growing with the rules. A lint is a rule
// about a KIND of work, so adding one without saying which kind is how the map
// would fall behind. The lints that predate the map are grandfathered in
// scripts/placement-baseline.json; do not add to it — claim your new lint.
//
//   npx tsx scripts/lint-placement.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEMENT } from "./placement-registry.js";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const baseline: string[] = JSON.parse(
  readFileSync(join(ROOT, "scripts", "placement-baseline.json"), "utf8"),
) as string[];

/** Lints that judge everything, so no single row owns them. */
const GENERAL = new Set([
  "lint:public-clean",
  "lint:instance-identity",
  "lint:no-emdash",
  "lint:secret-paths",
  "lint:node-resolves",
  "lint:dead-exports",
]);

const problems: string[] = [];

// 1 + 2 — the directories and exemplars a row points at.
for (const row of PLACEMENT) {
  for (const raw of row.dir.split(/\s+or\s+/)) {
    const dir = raw.trim().split(" ")[0]!;
    // "beside: …" is a real answer that is not a path (a pure test lives next
    // to the file it tests). Nothing to stat.
    if (!dir || dir.startsWith("(") || raw.trim().startsWith("beside:")) continue;
    const probe = dir.includes("<name>")
      ? dir.slice(0, dir.indexOf("<name>")) // modules/ exists even if <name> varies
      : dir;
    if (!existsSync(join(ROOT, probe))) {
      problems.push(`${row.id}: dir "${dir}" does not exist`);
    }
  }
  if (!existsSync(join(ROOT, row.exemplar))) {
    problems.push(
      `${row.id}: exemplar "${row.exemplar}" does not exist — point at a real file, ` +
        `since that file IS the template`,
    );
  }
  // 3 — the lints it names.
  for (const l of row.lints) {
    if (!pkg.scripts[l]) problems.push(`${row.id}: "${l}" is not a script in package.json`);
  }
}

// 4 — every lint script is claimed, general, or grandfathered.
const claimed = new Set(PLACEMENT.flatMap((r) => r.lints));
const scriptLints = Object.keys(pkg.scripts).filter(
  (s) => s.startsWith("lint:") && s !== "lint:all",
);
const unclaimed = scriptLints.filter(
  (l) => !claimed.has(l) && !GENERAL.has(l) && !baseline.includes(l),
);
for (const l of unclaimed) {
  problems.push(
    `"${l}" is enforced but the map does not say which kind of work it governs.\n` +
      `      Add it to a row's \`lints\` in scripts/placement-registry.ts (or to GENERAL here if it\n` +
      `      truly judges everything). A rule nobody can find before writing code is a rule people\n` +
      `      only meet in CI.`,
  );
}

// A baseline entry that no longer names a real lint is dead weight — say so, so
// the grandfathered list shrinks instead of rotting.
for (const l of baseline) {
  if (!pkg.scripts[l]) problems.push(`placement-baseline.json lists "${l}", which is no longer a script — drop it`);
}

// (The question "is every lint file actually wired up?" already has an owner:
// lint:lints-are-wired. Asking it again here would be a second copy of a rule,
// which is the drift this whole map exists to prevent.)

if (problems.length) {
  console.error(`✗ lint:placement — ${problems.length} problem(s) with the "where does this go" map:\n`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error(
    `\n  The map is scripts/placement-registry.ts and it answers ` +
      `\`pnpm run where "<what you are building>"\`.\n`,
  );
  process.exit(1);
}
console.log(
  `lint:placement ✓ the placement map is current — ${PLACEMENT.length} kinds of work, ` +
    `${claimed.size} lints claimed, ${baseline.length} grandfathered.`,
);
