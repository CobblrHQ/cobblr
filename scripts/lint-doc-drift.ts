// Guards docs/architecture/ against the drift class that a 2026-08 review found
// all over these docs: prose that keeps describing a renamed module (core-farm),
// a removed one (core-labels-qr), a module that was never built (core-resolver),
// or a manifest field the contract doesn't have (healthProbes, uiComponents, ...).
//
// The docs drifted because nothing tied them to the code. Prose still needs human
// review, but the MECHANICAL drift - dead module names, ghost fields - is
// catchable, so it can't silently rot back in. This is the "prevent the class"
// layer for the doc fixes, not a substitute for reading them.
//
// It scans docs/architecture/*.md and fails on:
//   - a `core-<name>` token with no matching modules/<name> dir (dead module ref)
//   - a retired module name (renamed/removed) used as if current
//   - a manifest field name that isn't in the defineModule contract
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCH = join(ROOT, "docs", "architecture");

const MODULES = new Set(
  readdirSync(join(ROOT, "modules")).filter((d) => {
    try { return statSync(join(ROOT, "modules", d)).isDirectory(); } catch { return false; }
  }),
);

// Retired module names (renamed or removed) that must not appear as current.
const RETIRED: Record<string, string> = {
  "core-farm": "renamed to `digifab`",
  "core-labels-qr": "split into `labels` + `core-print`",
  "core-resolver": "never a module - the resolver is a kernel primitive (api/src/platform/entities.ts)",
};

// Manifest field names the defineModule contract does NOT have. A doc citing one
// is describing an API that doesn't exist. (The Zod ModuleManifest in
// packages/platform-contract is the source of truth.)
const GHOST_FIELDS: Record<string, string> = {
  healthProbes: "probes register at runtime via platform().health.registerProbe in lifecycle.onBoot",
  skillsDir: "not a manifest field",
  bulkSafe: "not an EntityAction field",
  uiComponents: "UI is nested: ui.components (+ ui.navItems)",
  minVersion: "dependencies are plain module-name strings; there is no version constraint",
};

// core-* tokens that legitimately appear in prose but are not module dirs.
// Add here ONLY with a stated reason.
const NON_MODULE_ALLOW = new Set<string>([]);

const hits: string[] = [];
for (const f of readdirSync(ARCH).filter((f) => f.endsWith(".md"))) {
  const lines = readFileSync(join(ARCH, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `docs/architecture/${f}:${i + 1}`;
    for (const [name, why] of Object.entries(RETIRED))
      if (line.includes(name)) hits.push(`${at}  retired name "${name}" (${why})`);
    for (const [field, why] of Object.entries(GHOST_FIELDS))
      if (new RegExp(`\\b${field}\\b`).test(line)) hits.push(`${at}  ghost manifest field "${field}" (${why})`);
    for (const m of line.matchAll(/\bcore-[a-z][a-z0-9-]+/g)) {
      const tok = m[0];
      const before = line[m.index! - 1] ?? "";
      const after = line[m.index! + tok.length] ?? "";
      if (before === "/" || after === "." || after === "/") continue; // a path/filename (e.g. e2e/core-x.mjs), not a module ref
      if (MODULES.has(tok) || NON_MODULE_ALLOW.has(tok) || tok in RETIRED) continue;
      hits.push(`${at}  "${tok}" has no modules/ dir (dead module reference)`);
    }
  });
}

if (hits.length) {
  console.error("\n✖ lint:doc-drift - architecture docs cite code that doesn't exist:\n");
  for (const h of hits) console.error(`  ${h}`);
  console.error("\n  Fix the doc. For a legitimate non-module `core-*` mention, add it to NON_MODULE_ALLOW with a reason.\n");
  process.exit(1);
}
console.log("lint:doc-drift - architecture docs match the module set + contract ✓");
