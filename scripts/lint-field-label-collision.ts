// Two columns must never share a heading.
//
// A real table read:
//
//   #ID │ NAME │ CATEGORY │ LOCATION │ KEPT │ CATEGORY │ ON
//
// Two columns headed CATEGORY. Inventory has a native `category`, and the
// groceries bundle added a custom `food_category` whose display_label was, word
// for word, "Category". Nothing failed: both are valid fields, and the table
// dutifully rendered a header for each. The reader is left to work out which is
// which by looking at the values.
//
// THE CLASS: a bundle names a field after a concept the module already has, and
// the duplicate only shows up as two identical headings on a screen nobody
// diffed. It cannot be caught by types - the labels are strings in a manifest -
// so it needs a check at authoring time.
//
// The native label set is DERIVED from the module UIs (`fp.label("category",
// "Category")`) rather than hand-kept here, so a module that adds a native field
// widens the net without anybody remembering to update this file.

import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

interface FieldDef {
  entity_kind?: string;
  name?: string;
  display_label?: string;
}
interface Instance {
  module?: string;
  instance_name?: string;
  field_defs?: FieldDef[];
  field_overrides?: Array<{ name?: string; hidden?: boolean; display_label?: string }>;
}
interface Manifest {
  id?: string;
  field_defs?: FieldDef[];
  provides_instances?: Instance[];
  features?: Array<{ field_defs?: FieldDef[]; provides_instances?: Instance[] }>;
}

/** Native fields each module renders, as (module → name → default label).
 *  Read from the module UIs' own `fp.label("<name>", "<Default>")` calls. */
function nativeLabels(): Map<string, Map<string, string>> {
  const byModule = new Map<string, Map<string, string>>();
  for (const f of sourceFiles("modules/*/src/ui/**/*.tsx")) {
    const mod = f.split("/")[1];
    if (!mod) continue;
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(/fp\.label\(\s*"([a-z0-9_]+)"\s*,\s*"([^"]+)"\s*\)/g)) {
      const name = m[1]!;
      const label = m[2]!;
      if (!byModule.has(mod)) byModule.set(mod, new Map());
      byModule.get(mod)!.set(name, label);
    }
  }
  return byModule;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

const natives = nativeLabels();
const problems: string[] = [];

for (const file of sourceFiles("bundles/*.json")) {
  let manifest: Manifest;
  try {
    manifest = (JSON.parse(readFileSync(file, "utf8")) as { manifest?: Manifest }).manifest ?? {};
  } catch {
    continue;
  }
  const bundle = file.split("/").pop() ?? file;

  /** One table's worth of custom fields, plus the module whose natives it inherits. */
  const check = (label: string, defs: FieldDef[], mod: string, hidden: Set<string>): void => {
    const seen = new Map<string, string>();
    for (const d of defs) {
      const dl = d.display_label;
      const nm = d.name;
      if (!dl || !nm) continue;
      const key = norm(dl);
      const clash = seen.get(key);
      if (clash && clash !== nm) {
        problems.push(`${bundle}: ${label} has two fields labelled "${dl}" (${clash}, ${nm})`);
      }
      seen.set(key, nm);
      // ...and against the module's own native fields, unless this table hides
      // the native one (which is the correct way to REPLACE it).
      for (const [nName, nLabel] of natives.get(mod) ?? []) {
        if (nName === nm || hidden.has(nName)) continue;
        if (norm(nLabel) === key) {
          problems.push(
            `${bundle}: ${label} field "${nm}" is labelled "${dl}", which is also ${mod}'s native "${nName}" — rename it, or hide the native with a field_override`,
          );
        }
      }
    }
  };

  const allInstances = [
    ...(manifest.provides_instances ?? []),
    ...(manifest.features ?? []).flatMap((f) => f.provides_instances ?? []),
  ];
  const baseDefs = [
    ...(manifest.field_defs ?? []),
    ...(manifest.features ?? []).flatMap((f) => f.field_defs ?? []),
  ];

  // Base field defs land on the module's own default table.
  const byKind = new Map<string, FieldDef[]>();
  for (const d of baseDefs) {
    const k = d.entity_kind ?? "";
    if (!k) continue;
    byKind.set(k, [...(byKind.get(k) ?? []), d]);
  }
  for (const [kind, defs] of byKind) {
    check(kind, defs, kind.split(":")[0] ?? "", new Set());
  }

  for (const inst of allInstances) {
    const hidden = new Set(
      (inst.field_overrides ?? []).filter((o) => o.hidden && o.name).map((o) => o.name!),
    );
    check(
      `${inst.instance_name ?? "?"} (table)`,
      inst.field_defs ?? [],
      inst.module ?? "",
      hidden,
    );
  }
}

if (problems.length > 0) {
  console.error(
    "[lint:field-label-collision] ✗ two columns would share a heading:\n" +
      problems.map((p) => `  ${p}`).join("\n") +
      "\n\n  A table showed `CATEGORY … CATEGORY` because a bundle's custom field\n" +
      "  reused a native field's label word for word. Nothing errors: both are\n" +
      "  valid fields and both get a header. Rename the custom one, or hide the\n" +
      "  native with a field_override when the custom field REPLACES it.",
  );
  process.exit(1);
}

console.log(`[lint:field-label-collision] ✓ no two fields on a table share a label`);
