#!/usr/bin/env tsx
// A first-party module that declares band foundational is on the kernel's curated foundational list, or it is silently a stock module no workspace is born with.
//
// THE BUG THIS PREVENTS. core-services (the Services job tables) and
// core-presentation both declared `band: "foundational"` and were never added
// to FOUNDATIONAL_ALLOWLIST in api/src/modules/enable.ts. The kernel treats an
// uncurated foundational flag as a stray, prints one warning at boot, and
// handles the module as a disableable stock module that signup does not
// enable and the boot reconcile does not heal. So no workspace had
// core_services_jobs: every service call answered `relation
// "core_services_jobs" does not exist`, while the api suite stayed green,
// because its fresh-workspace helper enables every loaded module by hand.
//
// THE RULE. Every `modules/<name>/src/module.ts` whose manifest says
// `band: "foundational"` is named in FOUNDATIONAL_ALLOWLIST. A module that
// should be optional says `band: "stock"` instead; a flag the kernel will
// ignore is never the way to say it.
//
// THE BOUNDARY. First-party modules only. The allowlist exists so a module
// from elsewhere (a sandboxed install) cannot make itself permanent by
// declaring the band; the warning is right for those and this lint does not
// read them.
//
//   npx tsx scripts/lint-foundational-is-curated.ts   (pnpm lint foundational-is-curated)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ENABLE = "api/src/modules/enable.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

function allowlist(): Set<string> {
  const src = readFileSync(ENABLE, "utf8");
  const m = /const FOUNDATIONAL_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) {
    console.error(`lint:foundational-is-curated - FOUNDATIONAL_ALLOWLIST not found in ${ENABLE}; update this lint with it.`);
    process.exit(1);
  }
  return new Set([...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
}

function check(curated: Set<string>): Violation[] {
  const out: Violation[] = [];
  for (const dir of readdirSync("modules")) {
    const file = join("modules", dir, "src", "module.ts");
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    const bandAt = lines.findIndex((l) => /^\s*band:\s*"foundational"/.test(l));
    if (bandAt < 0) continue;
    const name = /^\s*name:\s*"([^"]+)"/m.exec(lines.join("\n"))?.[1] ?? dir;
    if (!curated.has(name))
      out.push({
        file,
        line: bandAt + 1,
        what: `${name} declares band "foundational" but is not in FOUNDATIONAL_ALLOWLIST (${ENABLE}): no workspace is born with it`,
      });
  }
  return out;
}

const violations = check(allowlist());
if (violations.length) {
  console.error(`lint:foundational-is-curated - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error(`Add it to FOUNDATIONAL_ALLOWLIST in ${ENABLE}, or declare band "stock" if it is meant to be optional.`);
  process.exit(1);
}
console.log(`lint:foundational-is-curated OK`);
