// Guard: every catalog-schema key a bundle DECLARES must survive the shared
// CatalogSchemaConfig — because the bundle installer stores exactly what that
// zod keeps, and a key it doesn't know is silently dropped.
//
// Why this exists: `field_map` (and before it `exclude_from_global_search`) was
// declared on a Rebrickable catalog in the manifest but stripped on install by a
// strict zod that didn't list it — so quick-match auto-fill + Sets-leads-with-
// sets were dead end-to-end, and CI stayed green. This lint is the fast local
// check that would have caught it: it round-trips each bundle's catalog schemas
// through CatalogSchemaConfig and fails if any declared key is dropped (or the
// schema is otherwise invalid). Add the missing key ONCE, in
// packages/platform-contract (CatalogSchemaConfig), and both the module writer
// and the installer get it.
//
// Reads the generated bundles/*.json (kept in sync with featured-bundles.ts by
// lint:bundles-synced), so it checks exactly what ships.
//
// Run: npx tsx scripts/lint-catalog-schema-complete.ts
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
// Import the canonical schema from SOURCE (not the @cobblr/platform-contract
// package specifier, which resolves to an unbuilt dist under tsx). Still the one
// source of truth — the same const the module + installer use.
import { CatalogSchemaConfig } from "../packages/platform-contract/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "bundles");

type Catalog = { external_id?: string; schema?: Record<string, unknown> };
const problems: string[] = [];
let checked = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  let manifest: {
    catalogs?: Catalog[];
    features?: Array<{ catalogs?: Catalog[] }>;
  } | undefined;
  try {
    manifest = JSON.parse(readFileSync(join(DIR, file), "utf8")).manifest;
  } catch {
    continue;
  }
  if (!manifest) continue;
  const catalogs: Catalog[] = [
    ...(manifest.catalogs ?? []),
    ...(manifest.features ?? []).flatMap((f) => f.catalogs ?? []),
  ];
  for (const c of catalogs) {
    const schema = c.schema ?? {};
    const declared = Object.keys(schema);
    checked += 1;
    let parsed: Record<string, unknown>;
    try {
      parsed = CatalogSchemaConfig.parse(schema) as Record<string, unknown>;
    } catch (e) {
      problems.push(
        `${file}: catalog "${c.external_id}" has an INVALID schema — ${(e as Error).message.split("\n")[0]}`,
      );
      continue;
    }
    for (const k of declared) {
      if (!(k in parsed)) {
        problems.push(
          `${file}: catalog "${c.external_id}" schema key "${k}" is STRIPPED on install (not in CatalogSchemaConfig).`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(
    "[lint:catalog-schema-complete] a bundle declares a catalog-schema key the installer drops:\n",
  );
  for (const p of problems) console.error("  " + p);
  console.error(
    "\n  The installer stores exactly what CatalogSchemaConfig keeps. Declare the key ONCE\n" +
      "  in packages/platform-contract (CatalogSchemaConfig) so both the module writer and\n" +
      "  the bundle installer preserve it.",
  );
  process.exit(1);
}
console.log(
  `✓ catalog-schema-complete lint: ${checked} bundle catalog-schema(s) round-trip CatalogSchemaConfig with no dropped keys.`,
);
