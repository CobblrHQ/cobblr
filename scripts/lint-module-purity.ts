#!/usr/bin/env tsx
// Module purity lint — a kernel module is GENERIC. Its invokable ACTIONS must
// not carry a specific use-case / app / brand in their id or handler name; that
// knowledge belongs in BUNDLES (web/src/lib/featured-bundles.ts) + Tier-B apps,
// not a module. This is exactly what `inventory:bench-commit` got wrong — a
// CNC-bench-specific action bolted onto the generic inventory module — before it
// was split into the generic `inventory:create-item` + `core-scan:identify`.
//
// What it checks: every registered action handler name (`registerHandler("…")`),
// every manifest action id (`id: "module:action"`) + its `invokeHandler`, across
// modules/<m>/src, must not contain a use-case term from the list below.
//
//   cd <repo> && npx tsx scripts/lint-module-purity.ts
//
// Local + CI, free, zero deps. Add a justified exception to ALLOW (sparingly).

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

// Use-case / app / brand vocabulary that must live in bundles + apps, never in
// a generic module's action names. Keep specific (a generic word like "tool"
// is fine; "tooling"/"endmill" name a use-case).
const USE_CASE_TERMS = [
  "bench", "cataloging", "outfit", "wardrobe", "garment", "yarn", "skein",
  "filament", "spool", "lego", "rebrickable", "bricklink", "minifig",
  "tooling", "cnc", "endmill", "flute", "caliper", "needle",
];

// Justified, reviewed exceptions: the exact "<module>:<action>" or handler name.
const ALLOW = new Set<string>([
  // (none — keep this list tiny and each entry justified in review)
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) { if (e !== "node_modules" && e !== "ui") out.push(...walk(p)); }
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const offenders: { module: string; ident: string; kind: string; term: string; file: string }[] = [];
function check(module: string, ident: string, kind: string, file: string) {
  if (ALLOW.has(ident)) return;
  // Check only the VERB-NOUN — the part after the namespace separator
  // ("inventory:bench-commit" → "bench-commit", "bricklink:disassemble-kit" →
  // "disassemble-kit"). The namespace is always the module's own, so a domain
  // module (bricklink-connector) legitimately namespaces "bricklink:…"; what's
  // forbidden is a use-case verb-noun (the bench-commit smell).
  const verb = ident.replace(/^[a-z0-9_-]+[.:]/, "").toLowerCase();
  for (const t of USE_CASE_TERMS) {
    if (verb.includes(t)) { offenders.push({ module, ident, kind, term: t, file }); return; }
  }
}

const MODULES = "modules";
for (const m of readdirSync(MODULES)) {
  const src = join(MODULES, m, "src");
  if (!existsSync(src) || !statSync(src).isDirectory()) continue;
  for (const f of walk(src)) {
    const txt = readFileSync(f, "utf8");
    for (const mm of txt.matchAll(/registerHandler\(\s*["']([^"']+)["']/g)) check(m, mm[1], "action handler", f);
    for (const mm of txt.matchAll(/invokeHandler:\s*["']([^"']+)["']/g)) check(m, mm[1], "invokeHandler", f);
    // manifest action ids: id: "module:action" (colon-namespaced)
    for (const mm of txt.matchAll(/\bid:\s*["']([a-z0-9_-]+:[a-z0-9_-]+)["']/g)) check(m, mm[1], "action id", f);
  }
}

if (offenders.length === 0) {
  console.log("✓ module purity: no use-case-specific action names in any module.");
  process.exit(0);
}
console.error("✗ module purity: use-case/app/brand vocabulary in generic module actions —");
console.error("  that belongs in a bundle (featured-bundles.ts) + a Tier-B app, not a kernel module.");
console.error("  Split it into generic capabilities the bundle/app wires together (see");
console.error("  inventory:create-item + core-scan:identify), or add a justified ALLOW entry.\n");
for (const o of offenders) {
  console.error(`  • [${o.module}] ${o.kind} "${o.ident}" contains use-case term "${o.term}"  (${o.file})`);
}
process.exit(1);
