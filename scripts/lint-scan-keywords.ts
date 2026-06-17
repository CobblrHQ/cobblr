#!/usr/bin/env tsx
// scan_keywords purity lint — the matchmaker routes off a table's noun + FIELD
// defs (labels, help, choices); those are the routing signal a bundle already
// ships. An instance's optional `scan_keywords` is a DISAMBIGUATION OVERRIDE for
// the rare case two tables have *similar* fields — NOT a place to re-list what
// the fields already say. This lint fails when an instance's scan_keywords mostly
// duplicate its own fields (the smell the author caught: hand-typed keyword lists that
// just echo `fiber:[Wool,Cotton]` / `material:[PLA,PETG]`).
//
//   cd <repo> && npx tsx scripts/lint-scan-keywords.ts
//
// Local + CI, free, zero deps beyond importing the bundle source.
// See docs/architecture/wires-and-bundles.md (AI signals come from fields) +
// docs/modules/core-scan.md §scan_keywords.

import { FEATURED_BUNDLES } from "../web/src/lib/featured-bundles.ts";

// Words too generic to count as "the field already said this".
const STOP = new Set([
  "the", "a", "an", "of", "and", "or", "for", "to", "in", "with", "by",
  "your", "its", "it", "this", "that", "each", "per", "mm", "cm", "kg", "g",
  "type", "kind", "other", "blend", "each",
]);

const tokenize = (s: string): string[] =>
  String(s)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));

interface InstanceLike {
  instance_name?: string;
  display_name?: string;
  item_noun?: string;
  qty_unit?: string;
  scan_keywords?: string[];
  field_defs?: Array<{ display_label?: string; help?: string; choices?: string[] }>;
}

/** The "free" routing signal an instance already ships via its declared shape. */
function freeSignal(inst: InstanceLike): Set<string> {
  const out = new Set<string>();
  const add = (s?: string) => { for (const t of tokenize(s ?? "")) out.add(t); };
  add(inst.instance_name);
  add(inst.display_name);
  add(inst.item_noun);
  for (const f of inst.field_defs ?? []) {
    add(f.display_label);
    add(f.help);
    for (const c of f.choices ?? []) add(c);
  }
  return out;
}

/** A keyword is "covered" when every meaningful token in it is already in the
 *  field signal — i.e. it tells the matchmaker nothing the fields didn't. */
function keywordCovered(keyword: string, signal: Set<string>): boolean {
  const toks = tokenize(keyword);
  if (toks.length === 0) return true; // pure stopword/number → no signal
  return toks.every((t) => signal.has(t));
}

const offenders: Array<{ bundle: string; instance: string; covered: string[]; total: number }> = [];

function checkInstances(bundleId: string, instances: InstanceLike[] | undefined) {
  for (const inst of instances ?? []) {
    const kws = inst.scan_keywords ?? [];
    if (kws.length === 0) continue;
    const signal = freeSignal(inst);
    const covered = kws.filter((k) => keywordCovered(k, signal));
    // A majority of the keywords being field-duplicates = the smell. (A genuine
    // disambiguation override adds terms the fields DON'T carry — those won't be
    // "covered", so a well-justified override passes.)
    if (covered.length / kws.length > 0.5) {
      offenders.push({ bundle: bundleId, instance: inst.instance_name ?? "?", covered, total: kws.length });
    }
  }
}

for (const b of FEATURED_BUNDLES as Array<{ manifest?: { id?: string; provides_instances?: InstanceLike[]; features?: Array<{ provides_instances?: InstanceLike[] }> } }>) {
  const id = b.manifest?.id ?? "?";
  checkInstances(id, b.manifest?.provides_instances);
  for (const f of b.manifest?.features ?? []) checkInstances(id, f.provides_instances);
}

if (offenders.length > 0) {
  console.error("✗ scan_keywords lint: redundant keyword lists that duplicate the instance's own fields.\n");
  for (const o of offenders) {
    console.error(`  ${o.bundle} → instance "${o.instance}": ${o.covered.length}/${o.total} keywords are already covered by its fields/noun:`);
    console.error(`      ${o.covered.map((k) => `"${k}"`).join(", ")}`);
  }
  console.error(
    "\nThe matchmaker already routes off a table's noun + field labels/help/choices " +
      "(measured yarn ball-band → Yarn @ 0.97 with zero keywords). Remove the redundant " +
      "keywords; use scan_keywords ONLY as a disambiguation override for tables with " +
      "SIMILAR fields (terms the fields don't already carry).\n" +
      "See docs/modules/core-scan.md §scan_keywords + docs/architecture/wires-and-bundles.md.",
  );
  process.exit(1);
}

console.log("✓ scan_keywords lint: no flagship instance re-lists what its fields already say.");
