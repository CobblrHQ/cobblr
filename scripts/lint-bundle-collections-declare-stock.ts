#!/usr/bin/env tsx
// Every inventory collection a bundle provides declares faces.stock, so its data never decides whether its items wear stock verbs
//
// THE BUG THIS PREVENTS. A Home Inventory lamp opened on Use one, Used up and
// Replaced, with a quantity stepper and a reorder point (2026-09-24, #3646; the
// same shape as #2849 for a bookshelf). Home Inventory declared nothing about
// stock, so the platform decided from the data: one record saved with a
// reorder point of 0 read as stock signal and latched the whole collection to
// stock, for good, and every belonging in it put on consumable verbs.
//
// THE RULE. Each base entry in a bundle's `provides_instances` for module
// "inventory" carries `faces.stock` as true or false. A bundle knows whether
// it is a catalog of unique things or a store of counted stock; saying so
// outranks the data latch (stockDisclosureFromConfig: toggle, declared faces,
// latch, data), and a version bump heals every install through the bundle
// auto-updater. The data probe stays for collections a person makes
// themselves, where nobody declared anything.
//
// THE BOUNDARY. Instance entries inside a feature re-declare a base
// collection to attach wires or fields; the base entry's scalars win in the
// merge (mergeInstances), so only base entries are judged. Other modules'
// collections (machines, assets, records, projects) have no stock face.
//
//   npx tsx scripts/lint-bundle-collections-declare-stock.ts   (pnpm lint bundle-collections-declare-stock)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "bundles";

interface Violation {
  file: string;
  what: string;
}

const violations: Violation[] = [];
for (const name of readdirSync(DIR).sort()) {
  if (!name.endsWith(".json") || name.includes("lock")) continue;
  const file = join(DIR, name);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { manifest?: { provides_instances?: Array<{ module?: string; instance_name?: string; faces?: { stock?: unknown } }> } };
  for (const inst of raw.manifest?.provides_instances ?? []) {
    if (inst.module !== "inventory") continue;
    if (typeof inst.faces?.stock !== "boolean") {
      violations.push({ file, what: `collection "${inst.instance_name}" does not declare faces.stock; say whether it is a catalog (false) or counted stock (true), in web/src/lib/featured-bundles.ts` });
    }
  }
}

if (violations.length) {
  console.error(`lint:bundle-collections-declare-stock - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}  ${v.what}`);
  process.exit(1);
}
console.log(`lint:bundle-collections-declare-stock OK`);
