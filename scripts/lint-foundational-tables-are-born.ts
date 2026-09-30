#!/usr/bin/env tsx
// A first-party module that declares band foundational and owns migrations is on the kernel's foundational allowlist or sets autoEnable, so every workspace gets its tables.
//
// THE BUG THIS PREVENTS. core-services declared foundational and owned
// core_services_jobs, but was not on FOUNDATIONAL_ALLOWLIST, so no workspace
// was ever given the table (2026-09-29). The kernel treats an uncurated
// `band: "foundational"` as a stray and demotes it to stock (a warning in the
// log, nothing else), so signup and reconcileDefaultModules both skip it and
// its migrations never run. Every call into it would then fail with
// `relation ... does not exist` on a real workspace, while the test rig, which
// enables modules by hand, stayed green.
//
// THE RULE. For every modules/<name>/src/module.ts whose manifest says
// `band: "foundational"` and `migrationsDir:`, the name is in
// FOUNDATIONAL_ALLOWLIST (api/src/modules/enable.ts) or the manifest says
// `autoEnable: true`. No annotation opts out: a foundational module with
// tables that no workspace receives has no legitimate form.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. core-presentation declares
// foundational and is not on the list, but owns no tables: it only puts
// actions on the rail, so nothing is missing from a workspace. The rule stops
// at modules that own migrations, because tables that never arrive are the
// consequence; whether an uncurated action-only module should be curated is a
// separate question this lint does not answer.
//
//   npx tsx scripts/lint-foundational-tables-are-born.ts   (pnpm lint foundational-tables-are-born)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ENABLE = "api/src/modules/enable.ts";

function allowlist(): Set<string> {
  const src = readFileSync(ENABLE, "utf8");
  const m = /const FOUNDATIONAL_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) {
    console.error(`lint:foundational-tables-are-born - cannot find FOUNDATIONAL_ALLOWLIST in ${ENABLE}; update this lint with it.`);
    process.exit(2);
  }
  return new Set([...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
}

const curated = allowlist();
const violations: string[] = [];
for (const name of readdirSync("modules")) {
  const file = join("modules", name, "src", "module.ts");
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  if (!/\bband:\s*"foundational"/.test(src)) continue;
  if (!/\bmigrationsDir:/.test(src)) continue;
  if (/\bautoEnable:\s*true\b/.test(src)) continue;
  const declared = /\bname:\s*"([^"]+)"/.exec(src)?.[1] ?? name;
  if (!curated.has(declared)) violations.push(`${file}  ${declared} owns tables and declares foundational, but no workspace is born with it`);
}

if (violations.length) {
  console.error(`lint:foundational-tables-are-born - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(`Add the module to FOUNDATIONAL_ALLOWLIST in ${ENABLE}, or set autoEnable: true.`);
  process.exit(1);
}
console.log(`lint:foundational-tables-are-born OK (${curated.size} curated)`);
