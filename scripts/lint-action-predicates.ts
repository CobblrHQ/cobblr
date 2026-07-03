#!/usr/bin/env tsx
// Action-predicate lint — an action declaring `appliesTo: { any: true }`
// matches EVERY entity kind, which is either deliberate (event/args-driven
// shapes that locate their subject from the payload; genuinely-universal
// verbs like add-to-list) or lazy (the "show it everywhere = noise" failure
// mode docs/architecture/traits.md warns about — and exactly what rotted the
// /actions page into twenty "nothing to edit" rows, 2026-07-03).
//
// The rule: a universal predicate must SAY WHY. Any `appliesTo: { any: true }`
// in a module manifest needs the marker "DELIBERATELY universal" in a comment
// within the 8 preceding lines. New actions either scope honestly
// (traits/kinds) or justify universality at the declaration site.
//
//   cd <repo> && npx tsx scripts/lint-action-predicates.ts
//
// Local + CI, free, zero deps.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODULES_DIR = "modules";
const MARKER = "DELIBERATELY universal";
const LOOKBACK = 8;

const findings: string[] = [];
for (const mod of existsSync(MODULES_DIR) ? readdirSync(MODULES_DIR) : []) {
  const manifest = join(MODULES_DIR, mod, "src", "module.ts");
  if (!existsSync(manifest)) continue;
  const lines = readFileSync(manifest, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!/appliesTo:\s*\{\s*any:\s*true\s*\}/.test(line)) return;
    const context = lines.slice(Math.max(0, i - LOOKBACK), i).join("\n");
    if (context.includes(MARKER)) return;
    findings.push(`  ${manifest}:${i + 1}`);
  });
}

if (findings.length > 0) {
  console.error(`✗ action-predicate lint: ${findings.length} undocumented universal predicate(s).\n`);
  console.error(findings.join("\n"));
  console.error(`\nAn any:true action offers itself on EVERY entity kind. Either scope it honestly —
appliesTo: { traits: [...] } (open-set; tunable on /actions) or { kinds: [...] }
(module-internal precision) — or, if it's an event/args-driven shape with no
entity source, keep any:true and add a comment containing "${MARKER}"
within ${LOOKBACK} lines above, saying why. See docs/architecture/traits.md.`);
  process.exit(1);
}
console.log("✓ action-predicate lint: every universal predicate is documented.");
