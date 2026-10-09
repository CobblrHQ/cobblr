#!/usr/bin/env tsx
// A demo bundle never re-skins a base table with the fields a shipped bundle already ships as its own instance: it installs that bundle and adds to its table instead.
//
// THE BUG THIS PREVENTS. The Lego demo (demo-sites/lego-collector) put set
// number, theme, year, pieces and instructions onto the generic Parts table
// (`inventory:part`), five of the six fields the shipped Lego bundle gives its
// own Sets table. Every walkthrough and tour built on the demo then filmed
// sets as "Parts" with a "New part" button, a page nobody who installs Lego
// ever sees (#5083, #5157). The runtime guard in e2e/films-bundle.mjs cannot
// see this shape: the demo bundle ships no instance, so nothing tells it the
// base page is the wrong one.
//
// THE RULE. For each demo-sites/*/bundle.json, the field_defs it puts on a
// module's base kind (`<module>:<type>`, e.g. `inventory:part`) are compared
// with the fields each shipped bundle (bundles/*.json) gives an instance of
// that same module. Three or more names in common is a re-skin of that
// shipped bundle and fails. Field_defs on an instance's own kind
// (`sets:item`, as the spice-rack and Lego demos now do) are an add-on and
// pass.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. One shared name is common
// and harmless: the home-inventory demo's fields share one name with the
// warranties bundle, the garden demo one with plants, the workshop demo one with
// warranties. A re-skin shares most of its fields; the Lego demo shared 5 of
// 6. Three is the line between those.
//
//   npx tsx scripts/lint-demo-skin-not-a-shipped-instance.ts   (pnpm lint demo-skin-not-a-shipped-instance)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SHARED_NAMES_THAT_MAKE_A_RESKIN = 3;

interface FieldDef { entity_kind?: string; name?: string }
interface Manifest {
  id?: string;
  field_defs?: FieldDef[];
  provides_instances?: { module?: string; instance_name?: string; field_defs?: FieldDef[] }[];
  features?: { provides_instances?: { module?: string; instance_name?: string; field_defs?: FieldDef[] }[] }[];
}

export interface Violation { file: string; line: number; what: string }

function manifestOf(path: string): Manifest | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    return (d.manifest ?? d) as Manifest;
  } catch {
    return null;
  }
}

/** module → the shipped bundles' instances of it, with their field names. */
export function shippedInstances(bundles: Manifest[]): Map<string, { bundle: string; instance: string; fields: Set<string> }[]> {
  const out = new Map<string, { bundle: string; instance: string; fields: Set<string> }[]>();
  for (const m of bundles) {
    const instances = [...(m.provides_instances ?? []), ...(m.features ?? []).flatMap((f) => f.provides_instances ?? [])];
    for (const pi of instances) {
      if (!pi.module || !pi.instance_name) continue;
      const fields = new Set((pi.field_defs ?? []).map((f) => f.name).filter((n): n is string => !!n));
      const list = out.get(pi.module) ?? [];
      list.push({ bundle: m.id ?? "?", instance: pi.instance_name, fields });
      out.set(pi.module, list);
    }
  }
  return out;
}

export function check(file: string, demo: Manifest, shipped: ReturnType<typeof shippedInstances>, src = ""): Violation[] {
  if (demo.provides_instances?.length) return [];
  const byModule = new Map<string, Set<string>>();
  for (const f of demo.field_defs ?? []) {
    const [module] = (f.entity_kind ?? "").split(":");
    if (!module || !f.name || !shipped.has(module)) continue;
    const names = byModule.get(module) ?? new Set<string>();
    names.add(f.name);
    byModule.set(module, names);
  }
  const out: Violation[] = [];
  for (const [module, names] of byModule) {
    for (const inst of shipped.get(module) ?? []) {
      const shared = [...names].filter((n) => inst.fields.has(n));
      if (shared.length < SHARED_NAMES_THAT_MAKE_A_RESKIN) continue;
      const line = Math.max(1, src.split("\n").findIndex((l) => l.includes(`"${module}:`)) + 1);
      out.push({ file, line, what: `re-skins the base ${module} table with ${shared.length} of the fields ${inst.bundle} ships on its own /instances/${inst.instance} table (${shared.join(", ")}). Install ${inst.bundle} and put the demo's additions on \`${inst.instance}:item\`.` });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bundles = readdirSync("bundles").filter((n) => n.endsWith(".json")).map((n) => manifestOf(join("bundles", n))).filter((m): m is Manifest => !!m?.id);
  const shipped = shippedInstances(bundles);
  const violations: Violation[] = [];
  for (const dir of readdirSync("demo-sites")) {
    const file = join("demo-sites", dir, "bundle.json");
    if (!existsSync(file)) continue;
    const demo = manifestOf(file);
    if (demo) violations.push(...check(file, demo, shipped, readFileSync(file, "utf8")));
  }
  if (violations.length) {
    console.error(`lint:demo-skin-not-a-shipped-instance - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    process.exit(1);
  }
  console.log("lint:demo-skin-not-a-shipped-instance OK");
}
