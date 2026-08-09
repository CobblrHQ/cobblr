// Guard: a module that registers an instance LIST resolver must also register
// an instance SINGLE-ENTITY resolver.
//
// The trap this catches: the two are independent registrations, and the missing
// one fails INVISIBLY. With only the list resolver, a named collection renders
// perfectly — that is the list — while every generic single-record read
// (`platform().entities.lookup(orgId, "<instance>:item", id)`) returns null.
// Nothing errors; features that resolve one record just quietly do nothing.
//
// It shipped twice, in `records` and `assets`. It surfaced when the cover
// auto-fetch derives its search phrase from a lookup: for a book on a shelf the
// lookup returned null, so it derived no phrase and reported "these records
// need a name first" about books that plainly had names (reported 2026-07-18). The
// same hole silently degrades anything else that looks up one instance record.
//
// The rule, mechanically: for each modules/<name>/src/**, if the source calls
// registerInstanceListResolver it must also call registerInstanceResolver.
// (The reverse is allowed — a kind can be individually resolvable without being
// listable.)
// Run: npx tsx scripts/lint-instance-resolvers.ts

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MODULES = "modules";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const failures: string[] = [];
let checked = 0;

for (const mod of readdirSync(MODULES)) {
  const src = join(MODULES, mod, "src");
  if (!existsSync(src) || !statSync(src).isDirectory()) continue;
  const files = sourceFiles(src);
  const blob = files.map((f) => readFileSync(f, "utf8")).join("\n");
  if (!blob.includes("registerInstanceListResolver")) continue;
  checked++;
  if (!blob.includes("registerInstanceResolver(")) {
    failures.push(
      `${mod}: registers registerInstanceListResolver but NOT registerInstanceResolver — ` +
        `its collections will list fine while entities.lookup("<instance>:item", id) returns null ` +
        `for every single-record read`,
    );
  }
}

if (failures.length) {
  console.error("✗ lint-instance-resolvers: half-registered instance resolvers:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `✓ instance-resolvers lint: ${checked} multi-instance module(s) register BOTH the instance list and single-entity resolver`,
);
process.exit(0);
