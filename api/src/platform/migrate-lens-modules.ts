// One-shot migration: the four Pillar-E specialisation modules
// (3d-printers, laser-cutters, cnc-machines, workshop-mods) used to
// be modules that contributed field defs via `contributes.fieldDefs`
// in their manifest + a `dependencies` declaration for nav nesting.
//
// They had no schema, no api, no resolvers, no events — just field
// defs + a dependency edge. That's bundle territory.
//
// This migration:
//   1. For each org that had any of the four enabled, disable the
//      module (cleans up the source_module='X' field_defs + the
//      org_modules row).
//   2. Insert the equivalent bundle into the bundles table.
//   3. Re-create the field defs with bundle_id pointing at the new
//      bundle row.
//
// User data stored in entity metadata blobs (e.g. machines:
// machine.metadata.hotend) is untouched — it lives on the entity
// itself, not in module_field_defs. After the migration the same
// fields appear in the UI, just sourced from a bundle instead of a
// module.
//
// Idempotent: if the bundle is already installed for an org, only
// the module-disable runs. Safe to re-run on every boot until all
// affected orgs are migrated.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import type { FieldDefType } from "../db/schema.js";

interface LegacyFieldDef {
  entity_kind: string;
  name: string;
  display_label: string;
  type: FieldDefType;
  position?: number;
  choices?: string[];
}

interface LensManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  author: string;
  requires: Array<{ module: string }>;
  provides_lens: {
    entity_kind: string;
    name: string;
    display_name: string;
  };
  field_defs: LegacyFieldDef[];
}

const LENS_BUNDLES: Record<string, LensManifest> = {
  "3d-printers": {
    id: "cobblr.community.3d-printers",
    version: "0.1.0",
    name: "3D Printers",
    description:
      "Extends machines with 3D-printer-specific fields: hotend, extruder, board, firmware, bed_size, local_ip.",
    author: "Cobblr community",
    requires: [{ module: "machines" }],
    provides_lens: {
      entity_kind: "machines:machine",
      name: "3d-printers",
      display_name: "3D Printers",
    },
    field_defs: [
      {
        entity_kind: "machines:machine",
        name: "hotend",
        display_label: "Hotend",
        type: "text",
        position: 10,
        choices: [
          "Stock",
          "E3D V6",
          "E3D Volcano",
          "E3D Revo",
          "Phaetus Dragonfly",
          "Phaetus Rapido",
          "Mosquito",
          "Bondtech CHT",
        ],
      },
      {
        entity_kind: "machines:machine",
        name: "extruder",
        display_label: "Extruder",
        type: "text",
        position: 11,
        choices: [
          "Stock",
          "Bondtech LGX",
          "Bondtech LGX Lite",
          "Bondtech DDX",
          "BMG (clone)",
          "Titan",
          "Orbiter v2",
          "Sherpa Mini",
        ],
      },
      {
        entity_kind: "machines:machine",
        name: "board",
        display_label: "Mainboard",
        type: "text",
        position: 12,
        choices: [
          "Stock",
          "BTT SKR Mini E3",
          "BTT SKR 1.4 Turbo",
          "BTT Octopus",
          "Duet 3 6HC",
          "Duet 3 6XD",
          "MKS Robin Nano",
        ],
      },
      {
        entity_kind: "machines:machine",
        name: "firmware",
        display_label: "Firmware",
        type: "text",
        position: 13,
        choices: ["Stock", "Marlin", "Klipper", "RepRapFirmware", "Prusa Buddy"],
      },
      {
        entity_kind: "machines:machine",
        name: "bed_size",
        display_label: "Bed size (mm)",
        type: "text",
        position: 14,
        choices: ["180×180", "200×200", "220×220", "235×235", "250×250", "300×300", "350×350", "400×400"],
      },
      {
        entity_kind: "machines:machine",
        name: "local_ip",
        display_label: "Local IP / hostname",
        type: "text",
        position: 15,
      },
    ],
  },
  "laser-cutters": {
    id: "cobblr.community.laser-cutters",
    version: "0.1.0",
    name: "Laser Cutters",
    description:
      "Extends machines with laser-cutter-specific fields: tube_type, wattage, bed_size, cooling_type, focal_length.",
    author: "Cobblr community",
    requires: [{ module: "machines" }],
    provides_lens: {
      entity_kind: "machines:machine",
      name: "laser-cutters",
      display_name: "Laser Cutters",
    },
    field_defs: [
      {
        entity_kind: "machines:machine",
        name: "tube_type",
        display_label: "Tube type",
        type: "text",
        position: 20,
        choices: ["CO2 (sealed)", "CO2 (DC-excited)", "CO2 (RF)", "Diode", "Fiber", "Nd:YAG"],
      },
      {
        entity_kind: "machines:machine",
        name: "wattage",
        display_label: "Wattage (W)",
        type: "number",
        position: 21,
      },
      {
        entity_kind: "machines:machine",
        name: "bed_size_laser",
        display_label: "Bed size (mm)",
        type: "text",
        position: 22,
        choices: ["200×300", "300×400", "400×600", "500×700", "600×900", "900×1200", "1200×1600"],
      },
      {
        entity_kind: "machines:machine",
        name: "cooling_type",
        display_label: "Cooling",
        type: "text",
        position: 23,
        choices: ["Passive", "Water (open loop)", "Water (chiller)", "Air-cooled"],
      },
      {
        entity_kind: "machines:machine",
        name: "focal_length_mm",
        display_label: "Focal length (mm)",
        type: "number",
        position: 24,
      },
    ],
  },
  "cnc-machines": {
    id: "cobblr.community.cnc-machines",
    version: "0.1.0",
    name: "CNC Machines",
    description:
      "Extends machines with CNC-specific fields: spindle, axis_count, work_area, controller, coolant_type.",
    author: "Cobblr community",
    requires: [{ module: "machines" }],
    provides_lens: {
      entity_kind: "machines:machine",
      name: "cnc-machines",
      display_name: "CNC Machines",
    },
    field_defs: [
      {
        entity_kind: "machines:machine",
        name: "spindle",
        display_label: "Spindle",
        type: "text",
        position: 30,
        choices: [
          "Stock",
          "Makita RT0701C router",
          "DeWalt 611 router",
          "0.8kW VFD water-cooled",
          "1.5kW VFD water-cooled",
          "2.2kW VFD water-cooled",
          "ER11 air-cooled",
          "ER20 air-cooled",
        ],
      },
      {
        entity_kind: "machines:machine",
        name: "axis_count",
        display_label: "Axes",
        type: "number",
        position: 31,
      },
      {
        entity_kind: "machines:machine",
        name: "work_area",
        display_label: "Work area (mm)",
        type: "text",
        position: 32,
        choices: ["200×200×80", "300×300×100", "400×400×120", "600×900×150", "1200×1200×200", "1200×2400×200"],
      },
      {
        entity_kind: "machines:machine",
        name: "controller",
        display_label: "Controller",
        type: "text",
        position: 33,
        choices: ["GRBL", "Mach3", "Mach4", "LinuxCNC", "Buildbotics", "Acorn", "Centroid", "Fanuc"],
      },
      {
        entity_kind: "machines:machine",
        name: "coolant_type",
        display_label: "Coolant",
        type: "text",
        position: 34,
        choices: ["None", "Air blast", "Mist", "Flood", "MQL"],
      },
    ],
  },
  "workshop-mods": {
    id: "cobblr.community.workshop-mods",
    version: "0.1.0",
    name: "Workshop Mods",
    description:
      "Extends projects with the mod-on-a-machine workflow: substate vocabulary, energy estimate, excitement, public visibility. Mod ↔ machine link rides on the pairings primitive (relationship_kind='modifies').",
    author: "Cobblr community",
    requires: [{ module: "projects" }, { module: "machines" }],
    provides_lens: {
      entity_kind: "projects:project",
      name: "workshop-mods",
      display_name: "Workshop Mods",
    },
    field_defs: [
      {
        entity_kind: "projects:project",
        name: "mod_substate",
        display_label: "Mod substate",
        type: "text",
        position: 50,
        choices: ["planning", "parts-needed", "ready", "in-progress", "done", "abandoned"],
      },
      {
        entity_kind: "projects:project",
        name: "mod_energy",
        display_label: "Energy estimate",
        type: "text",
        position: 51,
        choices: ["small", "medium", "large"],
      },
      {
        entity_kind: "projects:project",
        name: "mod_excitement",
        display_label: "Excitement (0-5)",
        type: "number",
        position: 52,
      },
      {
        entity_kind: "projects:project",
        name: "mod_external_url",
        display_label: "External URL",
        type: "url",
        position: 53,
      },
      {
        entity_kind: "projects:project",
        name: "mod_public_visible",
        display_label: "Public visible",
        type: "boolean",
        position: 54,
      },
    ],
  },
};

/** Run the migration for one (org, legacy_module). Idempotent. */
async function migrateOne(orgId: string, legacyModule: string): Promise<{
  bundleInstalled: boolean;
  fieldsMoved: number;
}> {
  const manifest = LENS_BUNDLES[legacyModule];
  if (!manifest) return { bundleInstalled: false, fieldsMoved: 0 };

  // Step 1: skip if the equivalent bundle is already installed (e.g.
  // a re-run of the migration, or the user manually installed it
  // ahead of us).
  const existing = await meta
    .selectFrom("bundles")
    .select("id")
    .where("org_id", "=", orgId)
    .where("external_id", "=", manifest.id)
    .executeTakeFirst();

  if (existing) {
    // Bundle already there — just remove any leftover legacy module
    // field defs + the org_modules row.
    await meta
      .deleteFrom("module_field_defs")
      .where("org_id", "=", orgId)
      .where("source_module", "=", legacyModule)
      .execute();
    await meta
      .deleteFrom("org_modules")
      .where("org_id", "=", orgId)
      .where("module_name", "=", legacyModule)
      .execute();
    return { bundleInstalled: false, fieldsMoved: 0 };
  }

  // Step 2: clean up the legacy module's field defs (they're going
  // to be re-inserted with bundle_id). Avoids unique-constraint
  // collision when we insert the new ones.
  await meta
    .deleteFrom("module_field_defs")
    .where("org_id", "=", orgId)
    .where("source_module", "=", legacyModule)
    .execute();

  // Step 3: install the bundle row. Persist the full manifest so the
  // nav can later read `provides_lens` from it.
  const bundle = await meta
    .insertInto("bundles")
    .values({
      org_id: orgId,
      external_id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      source_url: null,
      manifest: sql`${JSON.stringify(manifest)}::jsonb` as unknown as Record<
        string,
        unknown
      >,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Step 4: re-insert field defs with bundle_id (and choices, which
  // the old bundle install path used to drop — see api/src/routes/
  // bundles.ts; that's been fixed alongside this migration).
  for (const f of manifest.field_defs) {
    await meta
      .insertInto("module_field_defs")
      .values({
        org_id: orgId,
        entity_kind: f.entity_kind,
        name: f.name,
        display_label: f.display_label,
        type: f.type,
        required: false,
        position: f.position ?? 0,
        bundle_id: bundle.id,
        choices: f.choices
          ? (sql`${JSON.stringify(f.choices)}::jsonb` as unknown as string[])
          : null,
      })
      .onConflict((b) => b.columns(["org_id", "entity_kind", "name"]).doNothing())
      .execute();
  }

  // Step 5: remove the org_modules row so the registry / nav stop
  // treating it as enabled.
  await meta
    .deleteFrom("org_modules")
    .where("org_id", "=", orgId)
    .where("module_name", "=", legacyModule)
    .execute();

  return { bundleInstalled: true, fieldsMoved: manifest.field_defs.length };
}

/** Boot-time entry point. Scans org_modules for any of the four
 *  legacy lens modules and converts each (org, module) pair to the
 *  equivalent bundle. */
export async function migrateLensModules(): Promise<{
  orgsTouched: number;
  bundlesInstalled: number;
  fieldsMoved: number;
}> {
  const targets = await meta
    .selectFrom("org_modules")
    .select(["org_id", "module_name"])
    .where("module_name", "in", Object.keys(LENS_BUNDLES))
    .execute();
  if (targets.length === 0) {
    return { orgsTouched: 0, bundlesInstalled: 0, fieldsMoved: 0 };
  }
  let bundlesInstalled = 0;
  let fieldsMoved = 0;
  const orgs = new Set<string>();
  for (const t of targets) {
    try {
      const out = await migrateOne(t.org_id, t.module_name);
      orgs.add(t.org_id);
      if (out.bundleInstalled) bundlesInstalled++;
      fieldsMoved += out.fieldsMoved;
    } catch (err) {
      console.error(
        `[migrate-lens] ${t.module_name} on org ${t.org_id} failed:`,
        (err as Error).message,
      );
    }
  }
  return { orgsTouched: orgs.size, bundlesInstalled, fieldsMoved };
}
