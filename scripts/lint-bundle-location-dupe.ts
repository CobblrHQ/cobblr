// Guard: a bundle must NOT declare a custom FIELD that duplicates the platform's
// native Location. A home item's room / a supply's area IS its Location (an area
// in the workspace tree) — a bespoke "room"/"area"/"location" text field is a
// SECOND, drifting "where" (the author, VG245: one scanned item showed a "Room" field
// AND the Location). This flags any field_def whose name is an unambiguous
// location word so a new bundle can't re-introduce the dupe.
//
// Field OVERRIDES are never flagged — relabeling or hiding the NATIVE `location`
// (e.g. { name: "location", hidden: true }) is exactly the right way to present
// it, so we only walk `field_defs`, never `field_overrides`.
//
// The vocabulary is deliberately the words that ONLY mean a physical place a
// thing is stored. Domain-ambiguous words (a plant "zone" = microclimate, food
// "storage" = a method, a "bin" = a size) are intentionally excluded: if one of
// those really is a place, file items into a Location and migrate the old values
// with the inventory:field-to-location bundle migration (see home-inventory /
// household-supplies) — don't just widen this list.
//
// Run: npx tsx scripts/lint-bundle-location-dupe.ts

import fs from "node:fs";
import path from "node:path";

const LOCATION_WORDS = new Set(["room", "area", "location", "aisle", "rack", "shelf"]);

/** Every field_def NAME anywhere a manifest can declare one — top level, each
 *  provides_instances[], each feature, and a feature's own provides_instances[].
 *  field_overrides are deliberately NOT walked (a native-location override is the
 *  correct pattern, not a dupe). */
function collectFieldDefNames(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.field_defs)) {
    for (const f of o.field_defs) {
      const name = (f as { name?: unknown })?.name;
      if (typeof name === "string") out.push(name);
    }
  }
  for (const key of ["provides_instances", "features"]) {
    const arr = o[key];
    if (Array.isArray(arr)) for (const child of arr) collectFieldDefNames(child, out);
  }
}

const dir = path.join(process.cwd(), "bundles");
const problems: string[] = [];
let checked = 0;

for (const file of fs.readdirSync(dir).sort()) {
  if (!file.endsWith(".json") || file.includes("lock")) continue;
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { manifest?: unknown };
  const manifest = raw.manifest ?? raw;
  checked++;
  const names: string[] = [];
  collectFieldDefNames(manifest, names);
  for (const n of names) {
    if (LOCATION_WORDS.has(n.trim().toLowerCase())) {
      problems.push(`${file}: field_def "${n}" shadows the native Location`);
    }
  }
}

if (problems.length > 0) {
  console.error(`lint:bundle-location-dupe: ${problems.length} bundle field(s) duplicate the native Location:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nDon't add a place field — file items into a Location (core-locations) instead; a view can group_by "location". If items already carry the value, retire it with the inventory:field-to-location bundle migration (see home-inventory / household-supplies). Relabeling/hiding the NATIVE "location" via field_overrides is fine.`,
  );
  process.exit(1);
}
console.log(`lint:bundle-location-dupe: ${checked} bundle(s) — no field_def shadows the native Location ✓`);
