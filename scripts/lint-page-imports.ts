#!/usr/bin/env tsx
// Page-imports lint — no page component may import another PAGE's internals.
//
// The gap this closes (machines-digifab-unification.md §1c): MachinesPage
// imported FleetView + two modals straight out of DigifabPage.tsx — a
// 5,700-line page file became a de-facto shared library, the machines page
// couldn't render without the digifab page bundle, and the composition was
// invisible to the module system. Shared UI belongs in web/src/components/,
// web/src/features/<module>/, or arrives via the panel registry
// (web/src/panels/registry.tsx — the manifest-declared contributes.panels
// seam).
//
// Rule: a file under web/src/pages/ must not import from a sibling module
// whose basename matches *Page (e.g. "./DigifabPage", "../pages/ScanPage").
// Non-page co-located files (e.g. ./PrintUpdatesPanel) are fine.
//
// Baseline: scripts/page-imports-baseline.json freezes the KNOWN existing
// imports (each is either deliberate page composition, like InstancePage
// rendering MachinesPage, or legacy debt to unwind). The lint is GREEN today
// and FAILS on any NEW page→page import. Shrink the baseline, never grow it.
//
// COMPOSITES (below) are a NARROWER, declared exception — not baseline debt.
// A composite is a settings page that exists only to host whole sibling pages
// as TABS: /configuration/devices is bridges + machine managers + printers,
// /fields is fields + form layout, /configuration/permissions is grants +
// roles + accounts. That is composition of complete pages, which is the
// opposite of the defect this lint was written for (MachinesPage reaching into
// DigifabPage's internals for FleetView and two modals).
//
// The distinction is enforced, not merely asserted: a composite may import ONLY
// the sibling pages listed for it, and only whole page components. Anything
// else still fails. Keeping these out of the baseline means the baseline stays
// a shrink-only list of real debt.
// See docs/design-decisions/configuration-revamp.md.
//
//   cd <repo> && npx tsx scripts/lint-page-imports.ts

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const PAGES_DIR = "web/src/pages";
const BASELINE_PATH = "scripts/page-imports-baseline.json";

/** Composite tab pages → the sibling pages each may host. */
const COMPOSITES: Record<string, string[]> = {
  "DevicesPage.tsx": ["./EdgeBridgesPage", "./DigifabPage", "./PrintPage"],
  "FieldsAndFormsPage.tsx": ["./FieldsPage", "./FormBuilderPage"],
  "PermissionsPage.tsx": ["./UsersPage", "./RolesPage"],
  "QrPage.tsx": ["./QrTokensPage", "./ScanRulesPage"],
};

interface Finding {
  file: string;
  line: number;
  spec: string;
}

const findings: Finding[] = [];
const IMPORT_RE = /from\s+["']([^"']+)["']/g;

for (const f of readdirSync(PAGES_DIR)) {
  if (!/\.(ts|tsx)$/.test(f)) continue;
  const path = join(PAGES_DIR, f);
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((l, i) => {
    for (const m of l.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      // Same-dir or ../pages/ specifier whose target basename ends in "Page"
      const inPages = spec.startsWith("./") || /(^|\/)pages\//.test(spec);
      if (!inPages) continue;
      const target = basename(spec);
      if (target !== basename(f, f.endsWith(".tsx") ? ".tsx" : ".ts") && /Page$/.test(target)) {
        // A declared composite may host exactly the siblings listed for it.
        if (COMPOSITES[f]?.includes(spec)) continue;
        findings.push({ file: path, line: i + 1, spec });
      }
    }
  });
}

const baseline: { file: string; spec: string }[] = existsSync(BASELINE_PATH)
  ? (JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { file: string; spec: string }[])
  : [];
const key = (v: { file: string; spec: string }) => `${v.file}::${v.spec}`;
const baselined = new Set(baseline.map(key));
const fresh = findings.filter((v) => !baselined.has(key(v)));
const stale = baseline.filter((b) => !findings.some((v) => key(v) === key(b)));

console.log(`page-imports lint: ${findings.length} total, ${findings.length - fresh.length} baselined, ${fresh.length} NEW`);
if (stale.length > 0) {
  console.log(`  (${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} stale — imports gone; prune ${BASELINE_PATH}: ${stale.map(key).join(", ")})`);
}
if (fresh.length > 0) {
  console.error(`\n✗ NEW page→page import(s):\n`);
  for (const v of fresh) console.error(`  ${v.file}:${v.line} — imports "${v.spec}"`);
  console.error(`\nA page must not import another page's internals. Move the shared component
to web/src/components/ or web/src/features/<module>/ — or, if this is one
module contributing UI into another module's page, declare it in the manifest
(contributes.panels) and register it in web/src/panels/registry.tsx.
See docs/design-decisions/machines-digifab-unification.md §5.`);
  process.exit(1);
}
console.log("✓ no new page→page imports");
