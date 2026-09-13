#!/usr/bin/env tsx
// A bundle manifest declares fields only on the kinds its own instances provide (<instance>:item), never on a module's base kind, unless base_kind_fields_reason says why.
//
// THE BUG THIS PREVENTS. The Groceries bundle kept a twin of its food fields on inventory:part for a workspace whose food still lived in plain Inventory; the twin's expiry role made every inventory instance perishable (#2849) and a wire twin of the same shape restocked twice (#2787). Retired by a boot pass (#2860, 2026-09-13).
//
// THE RULE. For every bundles/*.json manifest, every entry in the top-level
// `field_defs` names an `entity_kind`. That kind must be `<instance>:item`
// for an instance the same manifest lists under `provides_instances`
// (instance field defs already live under each instance and are not read
// here). A kind of any other shape, a module's base kind above all
// (`inventory:part`, `assets:asset`), fails, unless the manifest carries
// `base_kind_fields_reason: "<sentence>"`, which is the opt-out and its
// reason in one place; an empty reason does not count. Passes: a manifest
// with no top-level field_defs, or one whose top-level defs all name its own
// instances. bundles/*.json is generated from web/src/lib/featured-bundles.ts
// (scripts/sync-bundles.ts, kept in step by lint:bundles-synced), so the
// generated files are what is read: the shipped shape is the judged shape.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-bundle-fields-on-own-kinds.ts   (pnpm run lint:bundle-fields-on-own-kinds)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["bundles"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.json$/.test(name)) yield p;
  }
}

interface Manifest {
  id?: string;
  field_defs?: Array<{ entity_kind?: string; name?: string }>;
  provides_instances?: Array<{ instance_name?: string }>;
  base_kind_fields_reason?: string;
}

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  if (!/\.json$/.test(file) || file.includes("bundle-versions.lock")) return [];
  let manifest: Manifest;
  try {
    const parsed = JSON.parse(src) as { manifest?: Manifest };
    manifest = parsed.manifest ?? (parsed as Manifest);
  } catch {
    return [];
  }
  const defs = Array.isArray(manifest.field_defs) ? manifest.field_defs : [];
  if (defs.length === 0) return [];
  const own = new Set(
    (manifest.provides_instances ?? []).map((i) => (i.instance_name ? `${i.instance_name}:item` : "")).filter(Boolean),
  );
  const reason = typeof manifest.base_kind_fields_reason === "string" ? manifest.base_kind_fields_reason.trim() : "";
  const out: Violation[] = [];
  const lines = src.split("\n");
  // The top-level field_defs block is the first one at two-space depth; a
  // def's line is its "name" inside that block.
  const blockStart = lines.findIndex((l) => /^\s{4}"field_defs": \[/.test(l));
  for (const d of defs) {
    const kind = d.entity_kind ?? "";
    if (own.has(kind)) continue;
    if (reason) continue;
    const at = d.name ? lines.findIndex((l, i) => i > blockStart && l.includes(`"name": "${d.name}"`)) : -1;
    out.push({
      file,
      line: at >= 0 ? at + 1 : Math.max(1, blockStart + 1),
      what: `${manifest.id ?? file}: field "${d.name ?? "?"}" is declared on ${kind || "(no kind)"}, not on one of the bundle's own instances (${[...own].join(", ") || "none declared"}); a base-kind twin, or set base_kind_fields_reason`,
    });
  }
  return out;
}

const violations: Violation[] = [];
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:bundle-fields-on-own-kinds - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Move the fields under provides_instances[].field_defs, or set base_kind_fields_reason on the manifest with the sentence that justifies planting them on the base kind.");
  process.exit(1);
}
console.log(`lint:bundle-fields-on-own-kinds OK`);
