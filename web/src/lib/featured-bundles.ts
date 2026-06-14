// Featured bundle catalog — manifests embedded in the web app so
// users can one-click install without copy-pasting JSON. Until we
// have a hosted registry, this is the curated list.
//
// Each entry is the raw manifest we'd send to /bundles/install.
// Adding a bundle: drop a JSON manifest in bundles/<name>.json at
// the repo root, then import + push it here.

import type { PlatformBundleManifest, PlatformBundleFeature } from "./api";
import { OUTFIT_PLANNER_HTML } from "./outfit-planner-app";
import { CATALOGING_BENCH_HTML } from "./bench-app";

/** A post-install guided step — the "you can now add some yarn" prompt
 *  that shows after a bundle installs, so the user isn't left staring at
 *  a closed modal wondering what changed. */
export interface BundleNextStep {
  /** Button label, e.g. "Add your first yarn". */
  label: string;
  /** Module to navigate to (route segment under /w/<handle>), e.g. "inventory". */
  module: string;
  /** Explicit destination route (wins over `module`) — for landing in a module
   *  INSTANCE rather than the bare module, e.g. "/instances/yarn/items". */
  path?: string;
  /** One-line hint under the label. */
  hint?: string;
}

/** An opt-in capability of a bundle, toggled by a checkbox in the install
 *  modal. Phase 2: features live IN the manifest (manifest.features) so the
 *  backend stores them and they can be toggled later. The manifest's own
 *  arrays are the always-on BASE (the "thing"); features add the "what can
 *  I do with it". Naming rule: the bundle title is the noun; capabilities
 *  live here. */
export type BundleFeature = PlatformBundleFeature;

export interface FeaturedBundle {
  /** Includes the optional `features` array (opt-in capabilities). */
  manifest: PlatformBundleManifest;
  /** Short blurb shown on the catalog card. */
  blurb: string;
  /** Emoji or single-char glyph for the card. */
  glyph: string;
  /** Post-install guided next steps. When omitted, a generic "go to the
   *  modules this set up" list is derived from the manifest's requires. */
  next_steps?: BundleNextStep[];
}

/** Merge a manifest's BASE arrays with its selected features into one
 *  resolved manifest — used by the modal's live preview. The install sends
 *  the FULL manifest + the enabled feature keys and the backend resolves;
 *  this is display-only. requires are dedup-unioned by module. */
export function resolveBundleManifest(
  manifest: PlatformBundleManifest,
  selected: ReadonlySet<string>,
): PlatformBundleManifest {
  const on = (manifest.features ?? []).filter((f) => selected.has(f.key));
  if (on.length === 0) return manifest;
  const seen = new Set<string>();
  const requires = [...(manifest.requires ?? []), ...on.flatMap((f) => f.requires ?? [])].filter((r) =>
    seen.has(r.module) ? false : (seen.add(r.module), true),
  );
  return {
    ...manifest,
    requires,
    field_defs: [...(manifest.field_defs ?? []), ...on.flatMap((f) => f.field_defs ?? [])],
    wires: [...(manifest.wires ?? []), ...on.flatMap((f) => f.wires ?? [])],
    field_overrides: [...(manifest.field_overrides ?? []), ...on.flatMap((f) => f.field_overrides ?? [])],
    saved_views: [...(manifest.saved_views ?? []), ...on.flatMap((f) => f.saved_views ?? [])],
    provides_instances: [...(manifest.provides_instances ?? []), ...on.flatMap((f) => f.provides_instances ?? [])],
  };
}

/** Base next-steps plus the next-steps of any selected features. */
export function resolveNextSteps(
  base: BundleNextStep[] | undefined,
  features: BundleFeature[] | undefined,
  selected: ReadonlySet<string>,
): BundleNextStep[] {
  const on = (features ?? []).filter((f) => selected.has(f.key));
  return [...(base ?? []), ...on.flatMap((f) => f.next_steps ?? [])];
}

/** The post-install "where to start" steps for a bundle: the bundle's declared
 *  next_steps (base + selected features), else a fallback of one "go to" link
 *  per required DOMAIN module (`core-*` plumbing is filtered out — never a
 *  place a user "goes"). Shared by the install modal's landing panel and the
 *  persisted dashboard setup card so they always agree. */
export function deriveNextSteps(
  manifest: PlatformBundleManifest,
  baseNextSteps: BundleNextStep[] | undefined,
  selected: ReadonlySet<string>,
): BundleNextStep[] {
  const declared = resolveNextSteps(baseNextSteps, manifest.features, selected);
  if (declared.length) return declared;
  const resolved = resolveBundleManifest(manifest, selected);
  return [...new Set((resolved.requires ?? []).map((r) => r.module))]
    .filter((m) => !m.startsWith("core-"))
    .map((m) => ({ label: `Go to ${m.charAt(0).toUpperCase() + m.slice(1)}`, module: m }));
}

export const FEATURED_BUNDLES: FeaturedBundle[] = [
  {
    glyph: "🥬",
    blurb:
      "Track the fridge/pantry with expiry + storage, and auto-build a shopping list when something runs low or is about to expire. Check an item off → it restocks.",
    manifest: {
      id: "cobblr.flagship.food-cluster",
      version: "0.1.0",
      name: "Kitchen & Groceries",
      description:
        "Turn inventory + lists into a kitchen system: expiry + storage fields, auto shopping list on low-stock/expiry, restock on check-off.",
      author: "Cobblr",
      requires: [{ module: "inventory" }, { module: "lists" }],
      wires: [
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "lists.item.expiring", args: { listTitle: "Shopping list" } },
        { source_kind: "inventory:part", action_id: "inventory:adjust-stock", trigger_type: "event", trigger_event: "lists.item.checked", args: { delta: 1, reason: "Restocked — checked off the shopping list" } },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "expires_on", display_label: "Expires", type: "date", position: 1 },
        { entity_kind: "inventory:part", name: "opened_on", display_label: "Opened", type: "date", position: 2 },
        { entity_kind: "inventory:part", name: "storage", display_label: "Storage", type: "text", position: 3, choices: ["Fridge", "Freezer", "Pantry", "Counter", "Spice rack"] },
        { entity_kind: "inventory:part", name: "food_category", display_label: "Category", type: "text", position: 4, choices: ["Produce", "Dairy", "Meat", "Bakery", "Frozen", "Canned", "Dry goods", "Condiments", "Beverages", "Snacks"] },
      ],
    },
  },
  {
    glyph: "🥬➜📈",
    blurb:
      "Bridge: every grocery order you receive logs its cost as a 'Grocery spend' measurement — your spending trends like any metric. Set a monthly budget as the goal.",
    manifest: {
      id: "cobblr.flagship.kitchen-fitness",
      version: "0.1.0",
      name: "Kitchen × Fitness — grocery spend",
      description:
        "Connects the grocery flow to the Tracking module: order received → log spend into a metric. Neither module knows about the other.",
      author: "Cobblr",
      requires: [{ module: "purchases" }, { module: "tracking" }],
      wires: [
        {
          source_kind: "purchases:order_item",
          action_id: "tracking:log-measurement",
          trigger_type: "event",
          trigger_event: "purchases.order_item.received",
          args: { metricName: "Grocery spend", unit: "$", goalDirection: "down", valueKey: "lineCost", note: "auto-logged on order arrival" },
        },
      ],
    },
  },
  {
    glyph: "🧱",
    blurb:
      "Lego set inventory with set ID, year, theme, color, condition, and a label template that prints LEGO-flavored.",
    manifest: {
      id: "cobblr.community.lego",
      version: "0.1.0",
      name: "Lego",
      description:
        "Custom inventory fields + label wires for Lego set collections.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }, { module: "labels" }],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template:
            'LEGO {{theme | default: "misc"}} #{{set_id | default: "---"}} • {{name}} ({{year | default: "???"}})',
        },
      ],
      field_defs: [
        // Kit lifecycle (H6): the declarative half of sealed → built →
        // disassembled. The user marks a kit `sealed` (boxed) or `built`
        // here; the platform sets `parted-out` (and spawns `loose` parts)
        // when the disassemble-kit action runs. Stored in metadata.lifecycle
        // — the same key the parts list's lifecycle filter and the
        // disassemble handler read, so the field, the filter, and the
        // action all compose with no custom code.
        { entity_kind: "inventory:part", name: "lifecycle", display_label: "Kit state", type: "text", choices: ["loose", "sealed", "built", "parted-out"], position: 1 },
        { entity_kind: "inventory:part", name: "set_id", display_label: "Set ID", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "year", display_label: "Release year", type: "number", position: 3 },
        { entity_kind: "inventory:part", name: "theme", display_label: "Theme", type: "text", position: 4 },
        { entity_kind: "inventory:part", name: "color", display_label: "Primary color", type: "text", position: 5 },
        { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 6 },
        { entity_kind: "inventory:part", name: "minifig_count", display_label: "Minifig count", type: "number", position: 7 },
      ],
    },
  },
  {
    glyph: "🛠️",
    blurb:
      "Vintage hand tool collection — model, era, finish, condition. Prints labels with model + era so you can find them across a workshop.",
    manifest: {
      id: "cobblr.community.vintage-tools",
      version: "0.1.0",
      name: "Vintage Tools",
      description: "Custom fields + label wires for vintage hand tools.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }, { module: "labels" }],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: '{{maker | default: "—"}} {{model | default: "?"}} · {{era | default: "??"}} · {{name}}',
        },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "maker", display_label: "Maker", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "model", display_label: "Model", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "era", display_label: "Era", type: "text", position: 3 },
        { entity_kind: "inventory:part", name: "finish", display_label: "Finish", type: "text", position: 4 },
        { entity_kind: "inventory:part", name: "provenance", display_label: "Provenance", type: "text", position: 5 },
      ],
    },
  },
  {
    glyph: "🎛️",
    blurb:
      "3D printer parts — track voltage, datasheet URL, footprint, and a print-label template tuned for narrow bin labels. Uses the native `manufacturer` field.",
    manifest: {
      id: "cobblr.community.printer-parts",
      version: "0.2.0",
      name: "3D Printer Parts",
      description:
        "Datasheet-aware part fields + a narrow-bin label template. Manufacturer is a native inventory:part field; this bundle adds the electronics-specific extras.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }, { module: "labels" }],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: '{{name}}\n{{manufacturer | default: ""}} {{voltage | default: ""}}',
        },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "voltage", display_label: "Voltage", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "datasheet_url", display_label: "Datasheet URL", type: "url", position: 2 },
        { entity_kind: "inventory:part", name: "footprint", display_label: "Footprint / mount", type: "text", position: 3 },
      ],
    },
  },
  {
    glyph: "🌱",
    blurb:
      "Garden tracker — plants as assets with species, sun exposure, planted date, and an RRULE for the watering schedule that the recurrence scanner picks up automatically.",
    manifest: {
      id: "cobblr.community.garden",
      version: "0.1.0",
      name: "Garden",
      description:
        "Custom assets:asset fields for tracking plants — species, planted date, watering RRULE, sun exposure.",
      author: "Cobblr community",
      requires: [{ module: "assets" }],
      wires: [],
      field_defs: [
        { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1 },
        { entity_kind: "assets:asset", name: "planted_at", display_label: "Planted", type: "date", position: 2 },
        { entity_kind: "assets:asset", name: "water_rrule", display_label: "Watering schedule (RRULE)", type: "text", position: 3 },
        { entity_kind: "assets:asset", name: "sun", display_label: "Sun exposure", type: "text", position: 4 },
      ],
    },
  },
  {
    glyph: "📚",
    blurb:
      "Personal library — author, ISBN, year, read-status. Print spine labels with one wire.",
    manifest: {
      id: "cobblr.community.bookshelf",
      version: "0.1.0",
      name: "Bookshelf",
      description:
        "Catalog books as inventory parts. Each gets author + ISBN + year + read status. Spine-label wire bundled.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }, { module: "labels" }],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template:
            '{{author | default: "Unknown"}}\n{{name}}\n{{year | default: "?"}}',
        },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "author", display_label: "Author", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "isbn", display_label: "ISBN", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "year", display_label: "Year", type: "number", position: 3 },
        { entity_kind: "inventory:part", name: "read_status", display_label: "Status", type: "text", position: 4 },
        { entity_kind: "inventory:part", name: "rating", display_label: "Rating (1-5)", type: "number", position: 5 },
      ],
    },
  },
  {
    glyph: "🔧",
    blurb:
      "Tool library — checkout/checkin tracking. Marks machines with borrower, due_date, condition. Pair with the labels module to print barcoded check-out tags.",
    manifest: {
      id: "cobblr.community.tool-library",
      version: "0.1.0",
      name: "Tool Library",
      description:
        "Track who's borrowed a tool, when it's due back, and its condition. Custom machine:machine fields.",
      author: "Cobblr community",
      requires: [{ module: "machines" }],
      wires: [],
      field_defs: [
        { entity_kind: "machines:machine", name: "borrower", display_label: "Borrower", type: "text", position: 1 },
        { entity_kind: "machines:machine", name: "due_date", display_label: "Due back", type: "date", position: 2 },
        { entity_kind: "machines:machine", name: "condition", display_label: "Condition (1-5)", type: "number", position: 3 },
        { entity_kind: "machines:machine", name: "deposit_paid", display_label: "Deposit paid?", type: "text", position: 4 },
        { entity_kind: "machines:machine", name: "tool_category", display_label: "Category", type: "text", position: 5 },
      ],
    },
  },
  // ── Lens specialisations ──────────────────────────────────────────
  //
  // These were Pillar-E specialisation MODULES before — pure field-
  // def packages with `dependencies: ["machines"]` that drove the
  // lens-popover nav. They had no schema, no api, no resolvers, no
  // events. The principle "every feature is a user-enableable module
  // — nothing hardcoded" reads better when even these very domain-
  // specific things are bundles a builder turns on.
  //
  // `provides_lens` is the bundle-side replacement for the module-
  // dependency mechanic: the nav reads installed bundles for this
  // field and renders the lens chip under the parent module's
  // popover.
  {
    glyph: "🖨️",
    blurb:
      "3D printer fields — hotend, extruder, board, firmware, bed size, local IP. Drives the '3D printers' lens on the Machines page.",
    manifest: {
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
      wires: [],
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
  },
  {
    glyph: "🔥",
    blurb:
      "Laser cutter fields — tube type, wattage, bed size, cooling, focal length. Drives the 'Laser Cutters' lens on the Machines page.",
    manifest: {
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
      wires: [],
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
  },
  {
    glyph: "⚙️",
    blurb:
      "CNC machine fields — spindle, axes, work area, controller, coolant. Drives the 'CNC Machines' lens on the Machines page.",
    manifest: {
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
      wires: [],
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
  },
  {
    // "Yarn" ships as module INSTANCES, not a skin over generic inventory:
    // a "Yarn" instance of inventory (own nav entry, only yarn fields, "New
    // yarn" button), plus opt-in Hooks (inventory instance) and Designs
    // (projects instance). The studio capabilities are the opt-in features.
    glyph: "🧶",
    blurb:
      "Your yarn as its own thing — brand, colorway, fibre, weight, tracked by the skein, with only yarn fields and a grouped 'My yarn stash' view. Turn on extras: a Hooks table, a Designs table with patterns, an auto shopping list, and scan-to-add.",
    // Land in the Yarn TABLE (the inventory instance), not bare /inventory —
    // so "where to start" points at the thing the bundle just made.
    next_steps: [
      { label: "Add your yarn", module: "inventory", path: "/instances/yarn", hint: "Brand, colorway, fibre, weight — tracked by the skein." },
    ],
    manifest: {
      id: "cobblr.flagship.yarn",
      version: "0.4.0",
      name: "Yarn",
      description:
        "Yarn as its own inventory instance — skein-tracked, yarn-only fields, grouped by weight. Optional Hooks + Designs tables.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Real yarn-user polish: the Color field is a swatch picker (type a hex or pick one), Brand + Price now show right on the “New yarn” modal, and a “Suggested needle size” field was added. Dropdowns (vendor, fibre…) let you add a new option on the fly that sticks for next time. Dropped the confusing “Summary” computed field. — Yarn is its OWN table (a Yarn instance), not a skin over generic inventory: only yarn fields show, the button reads “New yarn”, quantities are in skeins. Hooks and Designs become their own tables too. The generic inventory cruft (warranty, insured, lifecycle…) is hidden, and the pinned view is named for its lens (“By weight”).",
      requires: [{ module: "inventory" }],
      // The always-on base: a "Yarn" instance of inventory.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "yarn",
          display_name: "Yarn",
          glyph: "🧶",
          item_noun: "yarn",
          qty_unit: "skein",
          field_defs: [
            { entity_kind: "inventory:part", name: "color", display_label: "Color", type: "text", position: 1, renderer: "color-hex", help: "The basic shade — pick a hex/colour for the swatch." },
            { entity_kind: "inventory:part", name: "colorway", display_label: "Colorway", type: "text", position: 2, help: "The maker's named shade — e.g. “Peacock Heather” (printed on the yarn label)." },
            { entity_kind: "inventory:part", name: "fiber", display_label: "Fibre", type: "text", position: 3, choices: ["Wool", "Merino", "Cotton", "Acrylic", "Nylon", "Chenille", "Alpaca", "Silk", "Linen", "Bamboo", "Cashmere", "Blend"], help: "What the yarn is made of." },
            { entity_kind: "inventory:part", name: "weight_class", display_label: "Weight", type: "text", position: 4, choices: ["0 – Lace", "1 – Fingering", "2 – Sport", "3 – DK", "4 – Worsted", "4 – Aran", "5 – Bulky", "6 – Super Bulky"], help: "Craft Yarn Council standard weight — 0 (Lace, thinnest) to 6 (Super Bulky, thickest)." },
            { entity_kind: "inventory:part", name: "vendor", display_label: "Vendor", type: "text", position: 5, choices: ["Michaels", "Hobby Lobby", "Walmart", "Joann", "Amazon", "Etsy", "Local yarn shop"], help: "Where you bought it." },
            { entity_kind: "inventory:part", name: "length_per_skein", display_label: "Length / skein (m)", type: "number", position: 6, help: "Metres per skein, from the label — used to estimate if you have enough for a project." },
            { entity_kind: "inventory:part", name: "dye_lot", display_label: "Dye lot", type: "text", position: 7, help: "The batch code on the label — buy the same lot so colours match across skeins." },
            { entity_kind: "inventory:part", name: "needle_size", display_label: "Suggested needle size", type: "text", position: 8, choices: ["2.0 mm", "2.5 mm", "3.0 mm", "3.5 mm", "4.0 mm", "4.5 mm", "5.0 mm", "5.5 mm", "6.0 mm", "6.5 mm", "7.0 mm", "8.0 mm", "9.0 mm", "10.0 mm", "12.0 mm"], help: "The needle/hook size the label recommends for this yarn (in mm)." },
          ],
          field_overrides: [
            // Relabel the few natives that matter for yarn…
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Price / skein" },
            // …and hide all the generic inventory cruft a yarn user doesn't want.
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By weight", view_type: "table", pinned: true, config: { group_by: "weight_class", visible_fields: ["title", "color", "colorway", "fiber", "vendor", "qty", "unit", "length_per_skein"] } },
          ],
        },
      ],
      features: [
      {
        key: "designs",
        name: "Designs",
        question: "Want to track your designs & patterns too?",
        description:
          "A 'Designs' table (a projects instance) — each design with its pattern (file/link) + category, and the yarn it needs allocated to it.",
        default: false,
        requires: [{ module: "projects" }],
        next_steps: [
          { label: "Open your Designs table", module: "projects", path: "/instances/designs", hint: "Each design with its pattern link + the yarn it needs." },
        ],
        provides_instances: [
          {
            module: "projects",
            instance_name: "designs",
            display_name: "Designs",
            glyph: "🧵",
            item_noun: "design",
            field_defs: [
              { entity_kind: "projects:project", name: "pattern_url", display_label: "Pattern link", type: "url", position: 1, renderer: "url-link", help: "Link to the pattern (Ravelry, a PDF, a blog post…)." },
              { entity_kind: "projects:project", name: "pattern_category", display_label: "Category", type: "text", position: 2, choices: ["Wearables", "Toys", "Home-wear", "Blankets"], help: "What kind of make this is." },
            ],
            saved_views: [
              { entity_kind: "projects:project", name: "By category", view_type: "table", pinned: true, config: { group_by: "pattern_category", visible_fields: ["title", "pattern_category", "status", "pattern_url"] } },
            ],
          },
        ],
      },
      {
        key: "hooks",
        name: "Hooks & needles",
        question: "Keep track of your hooks & needles?",
        description: "A separate 'Hooks' table (an inventory instance) — your crochet hooks / knitting needles by gauge + material.",
        default: false,
        next_steps: [
          { label: "Open your Hooks table", module: "inventory", path: "/instances/hooks", hint: "Crochet hooks / knitting needles by gauge + material." },
        ],
        provides_instances: [
          {
            module: "inventory",
            instance_name: "hooks",
            display_name: "Hooks",
            glyph: "🪡",
            item_noun: "hook",
            qty_unit: "each",
            field_defs: [
              { entity_kind: "inventory:part", name: "hook_gauge", display_label: "Hook gauge", type: "text", position: 1, choices: ["1.0 mm", "1.5 mm", "2.0 mm", "2.5 mm", "3.0 mm", "3.5 mm", "4.0 mm", "4.5 mm", "5.0 mm", "5.5 mm", "6.0 mm", "6.5 mm", "7.0 mm", "8.0 mm", "9.0 mm", "10.0 mm"], help: "Hook/needle size in mm (the number stamped on it)." },
              { entity_kind: "inventory:part", name: "hook_material", display_label: "Hook material", type: "text", position: 2, choices: ["All-metal", "Metal + silicone grip", "Wood", "Bamboo", "Plastic"], help: "What the hook is made of — affects grip + glide." },
            ],
            field_overrides: [
              { entity_kind: "inventory:part", name: "category", hidden: true },
              { entity_kind: "inventory:part", name: "location", hidden: true },
              { entity_kind: "inventory:part", name: "warranty", hidden: true },
              { entity_kind: "inventory:part", name: "min_qty", hidden: true },
              { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
              { entity_kind: "inventory:part", name: "serial_number", hidden: true },
              { entity_kind: "inventory:part", name: "model_number", hidden: true },
            ],
            saved_views: [
              { entity_kind: "inventory:part", name: "By material", view_type: "table", pinned: true, config: { group_by: "hook_material", visible_fields: ["title", "hook_gauge", "hook_material", "qty"] } },
            ],
          },
        ],
      },
      {
        key: "shopping-list",
        name: "Shopping list",
        question: "Auto-build a shopping list when yarn runs low?",
        description: "When yarn runs low it auto-lands on a 'Shopping list' so you know what to restock.",
        default: false,
        requires: [{ module: "lists" }],
        // Merge a wire into the existing Yarn instance (same instance_name →
        // install skips create + applies the wire scoped to yarn:item).
        provides_instances: [
          {
            module: "inventory",
            instance_name: "yarn",
            display_name: "Yarn",
            wires: [
              { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
            ],
          },
        ],
      },
      {
        key: "scan",
        name: "Scan to add",
        question: "Add yarn by scanning a barcode or receipt?",
        description: "Snap a barcode, skein label, or receipt to stock yarn fast (and log the purchase).",
        default: false,
        requires: [{ module: "core-scan" }, { module: "purchases" }],
      },
      ],
    },
  },
  {
    glyph: "🖨️🧵",
    blurb:
      "Two tables that work together. A filament TYPE (Royal Blue PLA) defines everything about the filament once — material, colour, diameter, the nozzle/bed temps, whether it needs drying. Then your SPOOLS just pick a type and add what's unique to the physical spool: its size, the maker's batch code, and how much is left. Each type rolls up how many spools + total kg you have.",
    // A type first (defines the filament), then spools of it.
    next_steps: [
      { label: "Add a filament type", module: "inventory", path: "/instances/filament-types", hint: "Define the filament once — brand, material, colour, diameter, temps." },
      { label: "Add a spool", module: "inventory", path: "/instances/filament", hint: "Pick its type, then just the spool size, batch code, and how much is left." },
    ],
    manifest: {
      id: "cobblr.flagship.filament-stash",
      version: "0.5.1",
      name: "Filament",
      description: "A filament TYPE (Royal Blue PLA) defines the filament once — material, colour, diameter, nozzle/bed temps, needs-drying. SPOOLS pick a type + add only what's per-spool: size, batch code, remaining, state. Each type rolls up its spool count + total kg.",
      author: "Cobblr",
      released_at: "2026-06-14",
      changelog:
        "Scanning a spool's QR (e.g. Polar's 3dqr.co code) now find-or-creates its filament TYPE and links the spool to it automatically — a scan lands in the type→spool model instead of a flat row. (0.5.0: the TYPE defines the whole filament — colour, diameter, nozzle/bed temps and needs-drying live on the type, not re-entered per spool; a SPOOL just picks its type and carries the per-spool facts — size, batch code, remaining, state. Upgrading carries your existing temps + colour up onto the type automatically.)",
      requires: [{ module: "inventory" }],
      // The bundle OWNS its data migration: on upgrade from any earlier install,
      // lift the flat `filament` spools into `filament-types` (deduped by the type
      // key), COPY the defining fields (temps + needs-drying) up onto the type,
      // link them, and convert grams → kg. Idempotent + automatic — runs through
      // the generic inventory:lift-to-type action, no script.
      migrations: [
        {
          to_version: "0.5.0",
          action: "inventory:lift-to-type",
          args: {
            source_instance: "filament",
            type_instance: "filament-types",
            key_fields: ["manufacturer", "material", "color", "diameter"],
            copy_fields: ["nozzle_temp", "bed_temp", "needs_drying"],
            relationship_kind: "instance-of",
            convert_qty: { from_unit: "g", to_unit: "kg", factor: 0.001 },
          },
        },
      ],
      provides_instances: [
        {
          // The TYPE — one row per kind of filament. Defines EVERYTHING about the
          // filament; every spool of it inherits these. The dedup key.
          module: "inventory",
          instance_name: "filament-types",
          display_name: "Filament types",
          glyph: "🧵",
          item_noun: "type",
          field_defs: [
            { entity_kind: "inventory:part", name: "material", display_label: "Material", type: "text", position: 1, choices: ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Nylon", "PC", "PVA", "Other"], help: "The plastic type — PLA is the easy default; PETG/ABS for tougher parts." },
            { entity_kind: "inventory:part", name: "color", display_label: "Colour", type: "text", position: 2, renderer: "color-hex", help: "Pick a swatch so the table shows the colour at a glance." },
            { entity_kind: "inventory:part", name: "diameter", display_label: "Diameter", type: "text", position: 3, choices: ["1.75 mm", "2.85 mm"], help: "Filament thickness — 1.75 mm is by far the most common; 2.85 mm for some older/large printers." },
            { entity_kind: "inventory:part", name: "nozzle_temp", display_label: "Nozzle °C", type: "number", position: 4, help: "The hot-end temperature that prints this filament cleanly — same for every spool of it." },
            { entity_kind: "inventory:part", name: "bed_temp", display_label: "Bed °C", type: "number", position: 5, help: "The bed temperature that makes the first layer stick." },
            { entity_kind: "inventory:part", name: "needs_drying", display_label: "Needs drying", type: "boolean", position: 6, choices: ["Stable", "Hygroscopic"], help: "Whether this filament tends to absorb moisture and should be kept dry / dried before use." },
            // Live rollups over the spools linked to this type (instance-of).
            { entity_kind: "inventory:part", name: "spool_count", display_label: "Spools", type: "computed", position: 7, template: "{{instances.count}}", help: "How many physical spools of this type you own." },
            { entity_kind: "inventory:part", name: "total_remaining", display_label: "In stock", type: "computed", position: 8, template: "{{instances.total_qty}} kg", help: "Total filament remaining across all your spools of this type." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "qty", hidden: true },
            { entity_kind: "inventory:part", name: "unit", hidden: true },
            { entity_kind: "inventory:part", name: "cost", hidden: true },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By material", view_type: "table", pinned: true, config: { group_by: "material", visible_fields: ["title", "color", "diameter", "spool_count", "total_remaining"] } },
          ],
        },
        {
          // The SPOOL — one row per physical spool. Picks a TYPE (inherits its
          // colour/temps/etc.) and carries ONLY what's unique to the spool.
          module: "inventory",
          instance_name: "filament",
          display_name: "Filament Spools",
          glyph: "🧵",
          item_noun: "spool",
          qty_unit: "kg",
          // The parent picker on manual creates — AND the scan auto-lift: a
          // scanned spool that carries material/colour/diameter find-or-creates
          // its "Royal Blue PLA" type (deduped by these keys, temps copied up)
          // and links to it, instead of landing as a flat row.
          parent: {
            instance: "filament-types",
            label: "Type",
            key_fields: ["manufacturer", "material", "color", "diameter"],
            copy_fields: ["nozzle_temp", "bed_temp", "needs_drying"],
          },
          field_defs: [
            { entity_kind: "inventory:part", name: "size", display_label: "Spool size", type: "text", position: 1, choices: ["0.5 kg", "1 kg", "2 kg", "3 kg", "4 kg", "5 kg", "25 kg"], help: "The full-spool size you bought (the label weight) — the remaining amount is tracked separately." },
            { entity_kind: "inventory:part", name: "batch_code", display_label: "Batch / lot code", type: "text", position: 2, help: "The batch or lot code from the maker's label (e.g. Polar's spool code) — for traceability of this exact spool." },
            { entity_kind: "inventory:part", name: "state", display_label: "State", type: "text", position: 3, choices: ["sealed", "open", "empty"], help: "Sealed = unopened; open = in use; empty = used up (keep it for the record or delete it)." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "qty", display_label: "Remaining (kg)" },
            { entity_kind: "inventory:part", name: "manufacturer", hidden: true },
            { entity_kind: "inventory:part", name: "cost", display_label: "Price / spool" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By state", view_type: "table", pinned: true, config: { group_by: "state", visible_fields: ["title", "size", "batch_code", "qty", "unit", "state"] } },
          ],
        },
      ],
    },
  },
  {
    // Title is the noun ("Home Inventory"); the insurance angle is an opt-in
    // feature, not the headline. Base = catalog what you own, room by room.
    glyph: "🏠",
    blurb:
      "Catalog what you own, room by room — make/model, condition, photos — in a grouped 'By room' view. Turn on insurance valuation to add replacement value + purchase details for a claim.",
    // Land in the Home Inventory TABLE (its own instance), not bare /inventory.
    next_steps: [
      { label: "Add your first item", module: "inventory", path: "/instances/home-inventory", hint: "What it is, which room, make/model, condition." },
    ],
    manifest: {
      id: "cobblr.flagship.home-inventory",
      version: "0.3.0",
      name: "Home Inventory",
      description: "Your belongings as their own room-by-room catalog — make/model + condition, grouped by room. Optional insurance valuation.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Home Inventory is now its OWN table (an inventory instance), not generic Inventory with extra columns — its own nav entry, a “New item” button, and only the fields a home catalog needs (the parts/warranty/supplier cruft is hidden). Plain-language hints added; the “By room” view stays pinned. Turn on Insurance valuation for replacement values + a claim-ready view.",
      requires: [{ module: "inventory" }],
      // Always-on base: a "Home Inventory" instance of inventory.
      provides_instances: [
        {
          module: "inventory",
          instance_name: "home-inventory",
          display_name: "Home Inventory",
          glyph: "🏠",
          item_noun: "item",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "room", display_label: "Room", type: "text", position: 1, choices: ["Living room", "Kitchen", "Primary bedroom", "Bedroom", "Bathroom", "Office", "Garage", "Basement", "Attic", "Outdoor", "Storage"], help: "Where it lives — the catalog groups by room so a claim/move is room-by-room." },
            { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 2, choices: ["New", "Excellent", "Good", "Fair", "Poor"], help: "Rough state, for resale or an insurance claim — New down to Poor." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Make / brand" },
            { entity_kind: "inventory:part", name: "model_number", display_label: "Model" },
            // Hide the generic inventory cruft a home catalog doesn't want.
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By room", view_type: "table", pinned: true, config: { group_by: "room", visible_fields: ["title", "manufacturer", "model_number", "condition", "qty"] } },
          ],
        },
      ],
      features: [
      {
        key: "insurance",
        name: "Insurance valuation",
        question: "Add insurance valuation (for a claim)?",
        description:
          "Add replacement value + where/when you bought each item, plus an 'Insurance valuation' view to hand an insurer after a fire/theft/move.",
        default: false,
        next_steps: [
          { label: "Value your items for insurance", module: "inventory", path: "/instances/home-inventory", hint: "Replacement value + where/when you bought each item." },
        ],
        // Add the insurance fields to the SAME Home Inventory instance.
        provides_instances: [
          {
            module: "inventory",
            instance_name: "home-inventory",
            display_name: "Home Inventory",
            field_defs: [
              { entity_kind: "inventory:part", name: "replacement_value", display_label: "Replacement value", type: "number", position: 3, help: "What it'd cost to buy new today — what an insurer pays out (not what you paid)." },
              { entity_kind: "inventory:part", name: "purchased_from", display_label: "Bought from", type: "text", position: 4, help: "Store or site — proof-of-purchase for a claim." },
              { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchased", type: "date", position: 5 },
            ],
            saved_views: [
              { entity_kind: "inventory:part", name: "Insurance valuation", view_type: "table", config: { group_by: "room", visible_fields: ["title", "room", "replacement_value", "purchase_date", "condition"] } },
            ],
          },
        ],
      },
      ],
    },
  },
  {
    glyph: "🧾",
    blurb:
      "Snap a receipt at purchase and never miss a warranty or return window. Tracks where/when you bought it, warranty + return-by dates, serial.",
    next_steps: [
      { label: "Add your first item", module: "inventory", path: "/instances/warranties", hint: "Make/model, where + when you bought it, the return-by date." },
    ],
    manifest: {
      id: "cobblr.flagship.warranties-receipts",
      version: "0.2.0",
      name: "Warranties & Receipts",
      description: "Your appliances/electronics as their own table — where/when you bought it + warranty and return-by dates, grouped by category.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns — its own nav entry, a “New item” button, only the fields a receipt/warranty tracker needs (the parts/stock cruft is hidden). Plain-language hints + a pinned “By category” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "warranties",
          display_name: "Warranties & Receipts",
          glyph: "🧾",
          item_noun: "item",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "purchased_from", display_label: "Bought from", type: "text", position: 1, help: "Store or site — proof-of-purchase for a warranty/return." },
            { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchased", type: "date", position: 2 },
            { entity_kind: "inventory:part", name: "return_by", display_label: "Return by", type: "date", position: 3, help: "The last day you can return it for a refund." },
            { entity_kind: "inventory:part", name: "category", display_label: "Category", type: "text", position: 4, choices: ["Appliance", "Electronics", "Tools", "Furniture", "Vehicle", "Other"] },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Make / brand" },
            { entity_kind: "inventory:part", name: "model_number", display_label: "Model" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By category", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "purchase_date", "return_by"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "💊",
    blurb:
      "What to take, the dose and schedule, and how many refills are left before you call the pharmacy. Caregiver-friendly; a 'Current meds' view.",
    next_steps: [
      { label: "Add your first medication", module: "inventory", path: "/instances/medications", hint: "Dose, schedule, refills left, refill-by date." },
    ],
    manifest: {
      id: "cobblr.flagship.medications",
      version: "0.3.0",
      name: "Medications & Refills",
      description: "Your medications as their own table — dose, schedule, instructions, prescriber/pharmacy, refills left + a refill-by date. Caregiver-friendly.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Richer prescription fields: Instructions + Important information (how to take it, warnings), a Time of day field (Morning/Midday/Evening/Bedtime), interval schedules (Every 4/6/8/12 hours) with a First-dose-at time, and a unit picker on the quantity. — Its OWN table (an inventory instance), not generic Inventory with extra columns: its own nav entry, a “New medication” button, only med fields (parts/warranty/supplier cruft hidden), plain-language hints + a pinned “Current meds” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "medications",
          display_name: "Medications",
          glyph: "💊",
          item_noun: "medication",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "dose", display_label: "Dose", type: "text", position: 1, help: "How much per take — e.g. “10 mg”, “1 tablet”, “5 mL”." },
            { entity_kind: "inventory:part", name: "schedule", display_label: "Schedule", type: "text", position: 2, choices: ["Once daily", "Twice daily", "Three times daily", "Every morning", "Every night", "As needed", "Weekly", "Every 4 hours", "Every 6 hours", "Every 8 hours", "Every 12 hours"] },
            { entity_kind: "inventory:part", name: "time_of_day", display_label: "Time of day", type: "text", position: 3, choices: ["Morning", "Midday", "Evening", "Bedtime", "Other / see directions"], help: "When in the day to take it — pick the closest, or type your own (e.g. “Morning, Evening”)." },
            { entity_kind: "inventory:part", name: "first_dose_at", display_label: "First dose at", type: "text", position: 4, help: "For interval schedules (e.g. every 8 hours), the time of the first dose — e.g. “8:00 AM”." },
            { entity_kind: "inventory:part", name: "instructions", display_label: "Instructions", type: "text", position: 5, help: "How to take it — e.g. “Take 1 capsule by mouth every 8 hours.”" },
            { entity_kind: "inventory:part", name: "important_information", display_label: "Important information", type: "text", position: 6, help: "Warnings or must-knows — e.g. “Take with food”, “Finish all of this medication.”" },
            { entity_kind: "inventory:part", name: "form", display_label: "Form", type: "text", position: 7, choices: ["Tablet", "Capsule", "Liquid", "Injection", "Inhaler", "Topical", "Drops"] },
            { entity_kind: "inventory:part", name: "prescriber", display_label: "Prescriber", type: "text", position: 8 },
            { entity_kind: "inventory:part", name: "pharmacy", display_label: "Pharmacy", type: "text", position: 9 },
            { entity_kind: "inventory:part", name: "rx_number", display_label: "Rx number", type: "text", position: 10, help: "The prescription number on the label — quote it to the pharmacy for a refill." },
            { entity_kind: "inventory:part", name: "refills_left", display_label: "Refills left", type: "number", position: 11, help: "Refills remaining before you need a new prescription." },
            { entity_kind: "inventory:part", name: "refill_by", display_label: "Refill by", type: "date", position: 12, help: "Order a refill by this date so you don't run out." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Maker" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "Current meds", view_type: "table", pinned: true, config: { visible_fields: ["title", "dose", "schedule", "refills_left", "refill_by"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🪴",
    blurb:
      "Stop killing your houseplants — light and watering needs per plant, grouped by light so the windowsill crowd sits apart from the shady corner.",
    next_steps: [
      { label: "Add your first plant", module: "assets", path: "/instances/plants", hint: "Species, light, how often to water." },
    ],
    manifest: {
      id: "cobblr.flagship.plant-care",
      version: "0.3.0",
      name: "Plant Care",
      description: "Your houseplants as their own table — species, light, watering interval + pot size, grouped by light.",
      author: "Cobblr",
      released_at: "2026-06-10",
      changelog:
        "Turn on Smart irrigation to let each plant water itself — its watering interval fires a Home Assistant service (or any controller) for that plant's zone + seconds, hands-free. — Now its OWN table (an assets instance), not generic Assets with extra columns — its own nav entry, a “New plant” button, only plant fields (the make/model/serial cruft is hidden). Plain-language hints + a pinned “By light” view.",
      requires: [{ module: "assets" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "plants",
          display_name: "Plant Care",
          glyph: "🪴",
          item_noun: "plant",
          field_defs: [
            { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1, help: "The plant's name/type — e.g. “Monstera”, “Snake plant”." },
            { entity_kind: "assets:asset", name: "light", display_label: "Light", type: "text", position: 2, choices: ["Low", "Medium", "Bright indirect", "Direct sun"], help: "How much light its spot gets — the table groups by this so similar plants sit together." },
            { entity_kind: "assets:asset", name: "water_every_days", display_label: "Water every (days)", type: "number", position: 3, help: "Days between waterings — e.g. 7 for weekly." },
            { entity_kind: "assets:asset", name: "last_watered", display_label: "Last watered", type: "date", position: 4 },
            { entity_kind: "assets:asset", name: "pot_size", display_label: "Pot size", type: "text", position: 5, help: "Pot diameter — e.g. “6 in”, “15 cm”." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
            { entity_kind: "assets:asset", name: "model", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "By light", view_type: "table", pinned: true, config: { group_by: "light", visible_fields: ["title", "species", "water_every_days", "last_watered", "pot_size"] } },
          ],
        },
      ],
      features: [
        {
          // Opt-in: turning a passive log into an actuator. Off by default so the
          // base bundle stays a simple plant table; enabling it pulls in digifab
          // (the device-command path) and wires each plant's watering interval to
          // a controller. Coordinate-not-control: Cobblr calls a Home Assistant
          // service over HTTP, it never drives a valve directly.
          key: "irrigation",
          name: "Smart irrigation",
          question: "Let plants water themselves?",
          description:
            "Each plant's watering interval fires a command at your irrigation controller for THAT plant's zone + duration — hands-free. Ships pointed at a Home Assistant `script.water_zone` service; connect Home Assistant (label it “Irrigation”) and it just works. Works with any HTTP controller via a driver manifest.",
          default: false,
          requires: [{ module: "digifab" }],
          next_steps: [
            { label: "Connect your controller", module: "digifab", path: "/configuration/farm", hint: "Install the Home Assistant driver, add a connection labelled “Irrigation”, paste a long-lived token." },
            { label: "Set each plant's zone + seconds", module: "assets", path: "/instances/plants", hint: "Which valve/zone waters it, and for how long." },
          ],
          // Add the two actuator fields to the SAME plants instance.
          provides_instances: [
            {
              module: "assets",
              instance_name: "plants",
              display_name: "Plant Care",
              field_defs: [
                { entity_kind: "assets:asset", name: "zone", display_label: "Irrigation zone", type: "text", position: 7, help: "Which valve/zone waters this plant — passed to the controller (e.g. “3”)." },
                { entity_kind: "assets:asset", name: "water_seconds", display_label: "Water (seconds)", type: "number", position: 8, help: "How long to run the zone each watering — in seconds." },
              ],
            },
          ],
          // The actuator wire: each plant's watering interval (water_every_days,
          // synthesised into a recurrence by the assets scanner) fires
          // assets.asset.recurred → run-command at the “Irrigation” connection
          // with THIS plant's own zone + seconds.
          wires: [
            {
              source_kind: "assets:asset",
              action_id: "digifab:run-command",
              trigger_type: "event",
              trigger_event: "assets.asset.recurred",
              args: {
                connection: "Irrigation",
                command: "run-zone",
                zone: "{{metadata.zone}}",
                seconds: "{{metadata.water_seconds}}",
              },
            },
          ],
        },
      ],
    },
  },
  {
    glyph: "🔁",
    blurb:
      "Every streaming service, membership, and recurring bill in one place — a computed per-cycle line + renewal dates, grouped by category.",
    next_steps: [
      { label: "Add your first subscription", module: "inventory", path: "/instances/subscriptions", hint: "Cost per cycle, billing cycle, renewal date." },
    ],
    manifest: {
      id: "cobblr.flagship.subscriptions",
      version: "0.2.1",
      name: "Subscriptions & Recurring Bills",
      description: "Every recurring charge as its own table — cost/cycle, renewal date, payment method, grouped by category.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Dropped the computed “Plan” summary line (clutter on the form). — Now its OWN table (an inventory instance), not generic Inventory with extra columns — its own nav entry, a “New subscription” button, only the fields a bills tracker needs (stock/parts cruft hidden). Plain-language hints + a pinned “Renews next” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "subscriptions",
          display_name: "Subscriptions",
          glyph: "🔁",
          item_noun: "subscription",
          field_defs: [
            { entity_kind: "inventory:part", name: "cost_per_cycle", display_label: "Cost / cycle", type: "number", position: 1, help: "What you're charged each billing cycle." },
            { entity_kind: "inventory:part", name: "billing_cycle", display_label: "Billing cycle", type: "text", position: 2, choices: ["Weekly", "Monthly", "Quarterly", "Yearly"] },
            { entity_kind: "inventory:part", name: "renewal_date", display_label: "Renews", type: "date", position: 3, help: "Next charge / renewal date — when to cancel by if you don't want it." },
            { entity_kind: "inventory:part", name: "category", display_label: "Category", type: "text", position: 4, choices: ["Streaming", "Software", "Membership", "Utility", "Insurance", "Phone / internet", "Other"] },
            { entity_kind: "inventory:part", name: "payment_method", display_label: "Paid with", type: "text", position: 5, help: "Which card/account it bills to." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "supplier_url", display_label: "Manage URL" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Provider" },
            { entity_kind: "inventory:part", name: "qty", hidden: true },
            { entity_kind: "inventory:part", name: "unit", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "Renews next", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "cost_per_cycle", "billing_cycle", "renewal_date"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "📚",
    blurb:
      "Catalog what you collect — books, wine, records, cards, coins — grouped by condition, with paid-vs-value, so you stop buying the dupe.",
    next_steps: [
      { label: "Add your first piece", module: "inventory", path: "/instances/collections", hint: "Condition, edition/year, what you paid + value today." },
    ],
    manifest: {
      id: "cobblr.flagship.collections",
      version: "0.2.0",
      name: "Collections",
      description: "Your collection as its own table — condition, edition, paid vs value today, grouped by condition, so you stop buying the dupe.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns — its own nav entry, a “New piece” button, only collector fields (parts/warranty/supplier cruft hidden). Plain-language hints + a pinned “By condition” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "collections",
          display_name: "Collections",
          glyph: "📚",
          item_noun: "piece",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 1, choices: ["Mint / Sealed", "Near Mint", "Excellent", "Good", "Fair", "Poor"], help: "Collector grade — the table groups by this; condition drives resale value." },
            { entity_kind: "inventory:part", name: "edition", display_label: "Edition / year", type: "text", position: 2, help: "Printing/pressing/edition or year — first editions, reissues, etc." },
            { entity_kind: "inventory:part", name: "acquired_date", display_label: "Acquired", type: "date", position: 3 },
            { entity_kind: "inventory:part", name: "acquired_price", display_label: "Paid", type: "number", position: 4 },
            { entity_kind: "inventory:part", name: "current_value", display_label: "Value today", type: "number", position: 5, help: "Roughly what it'd sell for now — for insurance or knowing your collection's worth." },
            { entity_kind: "inventory:part", name: "signed", display_label: "Signed / sealed", type: "boolean", position: 6, help: "Tick if signed, sealed, or otherwise special — usually a value bump." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Maker / label" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By condition", view_type: "table", pinned: true, config: { group_by: "condition", visible_fields: ["title", "edition", "current_value", "acquired_date"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🪪",
    blurb:
      "Passport, license, registration, insurance — every document that expires, with its number + issuer. Expiry dates land on your calendar automatically.",
    next_steps: [
      { label: "Add your first document", module: "assets", path: "/instances/documents", hint: "Type, number, issuer, and the expiry date." },
    ],
    manifest: {
      id: "cobblr.flagship.documents-renewals",
      version: "0.2.1",
      name: "Important Documents & Renewals",
      description: "Every document that expires as its own table — number/issuer/expiry, grouped by type, with expiry dates on your calendar.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Dropped the computed “Summary” line (clutter on the form). — Now its OWN table (an assets instance), not generic Assets with extra columns — its own nav entry, a “New document” button, only the fields a document tracker needs (make/model/serial cruft hidden). Plain-language hints + a pinned “Renewals” view.",
      requires: [{ module: "assets" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "documents",
          display_name: "Important Documents",
          glyph: "🪪",
          item_noun: "document",
          field_defs: [
            { entity_kind: "assets:asset", name: "doc_type", display_label: "Type", type: "text", position: 1, choices: ["Passport", "Driver's license", "Vehicle registration", "Insurance policy", "Membership", "Certification", "Visa / permit", "Warranty", "Other"], help: "What kind of document — the table groups by this." },
            { entity_kind: "assets:asset", name: "document_number", display_label: "Number", type: "text", position: 2, help: "The document/policy/licence number printed on it." },
            { entity_kind: "assets:asset", name: "issuer", display_label: "Issued by", type: "text", position: 3, help: "Who issued it — passport office, DMV, insurer, etc." },
            { entity_kind: "assets:asset", name: "issued_date", display_label: "Issued", type: "date", position: 4 },
            { entity_kind: "assets:asset", name: "expires_date", display_label: "Expires", type: "date", position: 5, help: "Expiry date — renew before this; it lands on your calendar." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
            { entity_kind: "assets:asset", name: "model", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "Renewals", view_type: "table", pinned: true, config: { group_by: "doc_type", visible_fields: ["title", "document_number", "issuer", "expires_date"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🐾",
    blurb:
      "Each pet's vitals + schedule — species, breed, birthday, vet, microchip, weight, and next-vet / rabies-due dates that land on your calendar.",
    next_steps: [
      { label: "Add your first pet", module: "assets", path: "/instances/pets", hint: "Species, breed, birthday, vet + vaccination dates." },
    ],
    manifest: {
      id: "cobblr.flagship.pet-care",
      version: "0.2.0",
      name: "Pet Care",
      description: "Your pets as their own table — vitals + vet/vaccination dates (calendar-reminded), grouped by species.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an assets instance), not generic Assets with extra columns — its own nav entry, a “New pet” button, only pet fields (make/model/serial cruft hidden). Plain-language hints + a pinned “By species” view.",
      requires: [{ module: "assets" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "pets",
          display_name: "Pet Care",
          glyph: "🐾",
          item_noun: "pet",
          field_defs: [
            { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1, choices: ["Dog", "Cat", "Rabbit", "Bird", "Reptile", "Fish", "Horse", "Other"], help: "The table groups pets by this." },
            { entity_kind: "assets:asset", name: "breed", display_label: "Breed", type: "text", position: 2 },
            { entity_kind: "assets:asset", name: "birthdate", display_label: "Birthday", type: "date", position: 3 },
            { entity_kind: "assets:asset", name: "weight_kg", display_label: "Weight (kg)", type: "number", position: 4, help: "Current weight — handy for dosing meds + spotting changes." },
            { entity_kind: "assets:asset", name: "vet", display_label: "Vet", type: "text", position: 5 },
            { entity_kind: "assets:asset", name: "microchip", display_label: "Microchip", type: "text", position: 6, help: "The chip ID registered to you — vets/shelters scan it to find the owner." },
            { entity_kind: "assets:asset", name: "next_vet_visit", display_label: "Next vet visit", type: "date", position: 7, help: "Next check-up — lands on your calendar." },
            { entity_kind: "assets:asset", name: "rabies_due", display_label: "Rabies due", type: "date", position: 8, help: "When the rabies vaccination is next due." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
            { entity_kind: "assets:asset", name: "model", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "By species", view_type: "table", pinned: true, config: { group_by: "species", visible_fields: ["title", "breed", "weight_kg", "next_vet_visit", "rabies_due"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🎁",
    blurb:
      "Stash gift ideas year-round — who, what occasion + its date, a link, a budget, and the idea→bought→wrapped→given pipeline. Dates hit your calendar.",
    next_steps: [
      { label: "Add your first gift idea", module: "inventory", path: "/instances/gifts", hint: "Who it's for, the occasion + its date, a budget." },
    ],
    manifest: {
      id: "cobblr.flagship.gifts-occasions",
      version: "0.2.0",
      name: "Gifts & Occasions",
      description: "Gift ideas as their own table — who, occasion + date (calendar-reminded), budget, and an idea→bought→wrapped→given pipeline.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns — its own nav entry, a “New gift” button, only gift-list fields (stock/parts cruft hidden). Plain-language hints + a pinned “By recipient” view.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "gifts",
          display_name: "Gifts & Occasions",
          glyph: "🎁",
          item_noun: "gift",
          field_defs: [
            { entity_kind: "inventory:part", name: "recipient", display_label: "For", type: "text", position: 1, help: "Who the gift is for — the table groups by this." },
            { entity_kind: "inventory:part", name: "occasion", display_label: "Occasion", type: "text", position: 2, choices: ["Birthday", "Christmas", "Anniversary", "Wedding", "Graduation", "Holiday", "Just because", "Other"] },
            { entity_kind: "inventory:part", name: "occasion_date", display_label: "Occasion date", type: "date", position: 3, help: "When you need it by — lands on your calendar." },
            { entity_kind: "inventory:part", name: "budget", display_label: "Budget", type: "number", position: 4 },
            { entity_kind: "inventory:part", name: "status", display_label: "Status", type: "text", position: 5, choices: ["Idea", "Bought", "Wrapped", "Given"], help: "Where it is in the pipeline — Idea → Bought → Wrapped → Given." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "supplier_url", display_label: "Idea link" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Store" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Spent" },
            { entity_kind: "inventory:part", name: "qty", hidden: true },
            { entity_kind: "inventory:part", name: "unit", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By recipient", view_type: "table", pinned: true, config: { group_by: "recipient", visible_fields: ["title", "occasion", "occasion_date", "budget", "status"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🧻",
    blurb:
      "Toiletries / cleaning / batteries hit their reorder level → auto onto the shopping list; check off after shopping → it restocks. Grouped by area.",
    next_steps: [
      { label: "Add your first supply", module: "inventory", path: "/instances/supplies", hint: "Set a reorder level so it auto-adds to your shopping list when low." },
    ],
    manifest: {
      id: "cobblr.flagship.household-supplies",
      version: "0.2.0",
      name: "Household Supplies auto-reorder",
      description: "Your household supplies as their own table — reorder level per supply auto-adds to a shopping list on low stock; check off → it restocks. Grouped by area.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an inventory instance), not generic Inventory with extra columns — its own nav entry, a “New supply” button, only the fields a supplies tracker needs. The low-stock → shopping-list → restock automation now lives on the Supplies table. Plain-language hints + a pinned “By area” view.",
      requires: [{ module: "inventory" }, { module: "lists" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "supplies",
          display_name: "Household Supplies",
          glyph: "🧻",
          item_noun: "supply",
          qty_unit: "each",
          // Low-stock → shopping list, and check-off → restock, scoped to this
          // instance (the installer rewrites source_kind to supplies:item).
          wires: [
            { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
            { source_kind: "inventory:part", action_id: "inventory:adjust-stock", trigger_type: "event", trigger_event: "lists.item.checked", args: { delta: 1, reason: "Restocked — checked off the shopping list" } },
          ],
          field_defs: [
            { entity_kind: "inventory:part", name: "area", display_label: "Area", type: "text", position: 1, choices: ["Bathroom", "Kitchen", "Laundry", "Cleaning", "Garage", "Office", "General"], help: "Where it's used/stored — the table groups by this." },
            { entity_kind: "inventory:part", name: "typical_pack", display_label: "Usual pack", type: "text", position: 2, help: "The pack size you usually buy — e.g. “12-pack”, “2 L” — so the shopping list is specific." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "min_qty", display_label: "Reorder at" },
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By area", view_type: "table", pinned: true, config: { group_by: "area", visible_fields: ["title", "qty", "unit", "typical_pack"] } },
          ],
        },
      ],
    },
  },
  {
    glyph: "🏡🔧",
    blurb:
      "The home version of Vehicle Maintenance — furnace, water heater, HVAC filters, detectors — with service logs + next-due dates on your calendar.",
    next_steps: [
      { label: "Add your first system", module: "assets", path: "/instances/maintenance", hint: "Furnace, water heater, HVAC filter — with its next-service date." },
    ],
    manifest: {
      id: "cobblr.flagship.home-maintenance",
      version: "0.2.0",
      name: "Home Maintenance Schedule",
      description: "Your home's systems as their own table — furnace, water heater, HVAC filters, detectors — with service logs + next-due dates on your calendar.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "Now its OWN table (an assets instance), not generic Assets with extra columns — its own nav entry, a “New system” button, only the fields a maintenance schedule needs. Plain-language hints + a pinned “By system” view; service logs come from core-maintenance.",
      requires: [{ module: "assets" }, { module: "core-maintenance" }],
      provides_instances: [
        {
          module: "assets",
          instance_name: "maintenance",
          display_name: "Home Maintenance",
          glyph: "🔧",
          item_noun: "system",
          field_defs: [
            { entity_kind: "assets:asset", name: "system_type", display_label: "System", type: "text", position: 1, choices: ["Furnace", "Air conditioner", "Water heater", "HVAC filter", "Smoke / CO detector", "Gutters", "Sump pump", "Dishwasher", "Washer", "Dryer", "Refrigerator", "Garage door", "Other"], help: "Which home system — the table groups by this." },
            { entity_kind: "assets:asset", name: "location", display_label: "Location", type: "text", position: 2, help: "Where it is — “Basement”, “Attic”, “Hallway ceiling”." },
            { entity_kind: "assets:asset", name: "installed_date", display_label: "Installed", type: "date", position: 3 },
            { entity_kind: "assets:asset", name: "filter_size", display_label: "Filter / part size", type: "text", position: 4, help: "The filter or replacement-part size to buy — e.g. “16×25×1” for a furnace filter." },
          ],
          field_overrides: [
            { entity_kind: "assets:asset", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "assets:asset", name: "model", display_label: "Model" },
            { entity_kind: "assets:asset", name: "short_name", hidden: true },
            { entity_kind: "assets:asset", name: "type", hidden: true },
            { entity_kind: "assets:asset", name: "serial_number", hidden: true },
            { entity_kind: "assets:asset", name: "excitement", hidden: true },
          ],
          saved_views: [
            { entity_kind: "assets:asset", name: "By system", view_type: "table", pinned: true, config: { group_by: "system_type", visible_fields: ["title", "location", "installed_date", "filter_size"] } },
          ],
        },
      ],
    },
  },
  {
    // Your closet as its own table; the visual outfit builder lives in the
    // companion Outfit Planner app (a Tier-B custom app that reads this
    // instance). Title is the noun ("Wardrobe"); planning is an opt-in feature.
    glyph: "👗",
    blurb:
      "Your closet as its own table — every garment by type, colour, season + a photo, grouped by type. Turn on Outfits to plan looks by occasion + date (and drag garments onto a figure in the Outfit Planner app).",
    next_steps: [
      { label: "Add your first garment", module: "inventory", path: "/instances/wardrobe", hint: "Type, colour, season — snap a photo so it shows in the closet." },
    ],
    manifest: {
      id: "cobblr.flagship.wardrobe",
      version: "0.1.1",
      name: "Wardrobe",
      description: "Catalog your clothing as its own table — type, colour, season, formality, a photo each — grouped by type. Optional Outfits table for planning looks.",
      author: "Cobblr",
      released_at: "2026-06-08",
      changelog:
        "First release — your wardrobe as its own inventory table (a “New garment” button, only clothing fields, the parts/stock cruft hidden), with a pinned “By type” view + plain-language hints. Turn on Outfits to plan looks by occasion + the date you'll wear them (they land on your calendar); the Outfit Planner app drags garments onto a figure.",
      requires: [{ module: "inventory" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "wardrobe",
          display_name: "Wardrobe",
          glyph: "👗",
          item_noun: "garment",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "garment_type", display_label: "Type", type: "text", position: 1, choices: ["Top", "Bottom", "Dress", "Outerwear", "Shoes", "Bag", "Accessory", "Jewelry", "Activewear", "Underwear", "Other"], help: "What kind of piece — the closet groups by this." },
            { entity_kind: "inventory:part", name: "color", display_label: "Colour", type: "text", position: 2, renderer: "color-hex", help: "Pick a swatch so the closet shows the colour at a glance." },
            { entity_kind: "inventory:part", name: "season", display_label: "Season", type: "text", position: 3, choices: ["Spring", "Summer", "Fall", "Winter", "All-season"], help: "When you wear it — filter to the right season fast." },
            { entity_kind: "inventory:part", name: "formality", display_label: "Formality", type: "text", position: 4, choices: ["Loungewear", "Casual", "Smart casual", "Work", "Formal", "Athletic"], help: "How dressed-up it is — for building work vs weekend looks." },
            { entity_kind: "inventory:part", name: "fabric", display_label: "Fabric", type: "text", position: 5, choices: ["Cotton", "Wool", "Linen", "Denim", "Leather", "Silk", "Knit", "Synthetic", "Blend", "Other"], help: "Main material — handy for care + seasonality." },
            { entity_kind: "inventory:part", name: "size", display_label: "Size", type: "text", position: 6 },
            { entity_kind: "inventory:part", name: "last_worn", display_label: "Last worn", type: "date", position: 7, help: "Update when you wear it — surfaces the pieces you never reach for." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By type", view_type: "table", pinned: true, config: { group_by: "garment_type", visible_fields: ["title", "color", "season", "formality", "manufacturer"] } },
            { entity_kind: "inventory:part", name: "By season", view_type: "table", config: { group_by: "season", visible_fields: ["title", "garment_type", "color", "formality"] } },
          ],
        },
      ],
      features: [
        {
          key: "outfits",
          name: "Outfit planning",
          question: "Plan outfits from your wardrobe?",
          description:
            "Adds an 'Outfits' table — each look by occasion + the date you'll wear it (so it lands on your calendar) — plus the Outfit Planner app, where you drag garments onto a figure to compose a look visually.",
          default: true,
          // The Outfit Planner app needs core-apps (the App Player) enabled.
          requires: [{ module: "projects" }, { module: "core-apps" }],
          next_steps: [
            { label: "Open the Outfit Planner", module: "core-apps", path: "/app/outfit-planner", hint: "Drag garments onto a figure and save the look." },
            { label: "Plan an outfit", module: "projects", path: "/instances/outfits", hint: "Name the look, set the occasion + when you'll wear it." },
          ],
          // Seed the Outfit Planner app (a Tier-B custom block reading the
          // Wardrobe instance). See web/src/lib/outfit-planner-app.ts.
          provides_apps: [
            {
              slug: "outfit-planner",
              name: "Outfit Planner",
              icon: "👗",
              pages: [
                { slug: "plan", title: "Plan an outfit", blocks: [{ type: "custom", html: OUTFIT_PLANNER_HTML, height: 760 }] },
              ],
            },
          ],
          provides_instances: [
            {
              module: "projects",
              instance_name: "outfits",
              display_name: "Outfits",
              glyph: "👚",
              item_noun: "outfit",
              field_defs: [
                { entity_kind: "projects:project", name: "occasion", display_label: "Occasion", type: "text", position: 1, choices: ["Everyday", "Work", "Date", "Event", "Travel", "Workout", "Special"], help: "What the look is for — the table groups by this." },
                { entity_kind: "projects:project", name: "wear_date", display_label: "Wear on", type: "date", position: 2, help: "When you'll wear it — lands on your calendar as “what to wear”." },
                { entity_kind: "projects:project", name: "pieces", display_label: "Pieces", type: "text", position: 3, help: "The garments in this look — jot them here, or build it visually in the Outfit Planner app." },
              ],
              saved_views: [
                { entity_kind: "projects:project", name: "By occasion", view_type: "table", pinned: true, config: { group_by: "occasion", visible_fields: ["title", "occasion", "wear_date"] } },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    // The Cataloging Bench (Phase 1). Your CNC tooling as its own table, plus a
    // guided "Bench" Tier-B app that captures an unknown tool's measurements +
    // observations + bin and composes its spec — no manual data entry. See
    // docs/product/cataloging-bench.md. The bench app needs core-apps (the App
    // Player); the commit goes through inventory's `bench-commit` action.
    glyph: "🔧",
    blurb:
      "Organize your CNC tooling — end mills, drills, taps — without typing. The guided Bench app walks each unknown tool through measure → weigh → observe → photograph → bin, composes its spec, and files it. AI enriches the name when a provider is connected.",
    next_steps: [
      { label: "Open the Bench", module: "core-apps", path: "/app/cataloging-bench", hint: "Run an unknown tool through measure → weigh → observe → bin — no typing." },
      { label: "See your Tooling table", module: "inventory", path: "/instances/tooling", hint: "Every tool by type, with its spec + which bin it's in." },
    ],
    manifest: {
      id: "cobblr.flagship.cnc-tooling",
      version: "0.2.0",
      name: "CNC Tooling",
      description:
        "Your CNC tooling as its own table — end mills, drills, taps, reamers, inserts — by type/diameter/flutes/material, with the bin each lives in. Ships the guided Cataloging Bench app: capture an unknown tool's measurements + observations and it composes the spec for you (AI-enriched when a provider is connected).",
      author: "Cobblr",
      released_at: "2026-06-12",
      changelog:
        "The guided Cataloging Bench: measure (caliper) → weigh (scale) → observe → photograph → bin, hands-busy, no typing — with a live edge mode that streams real readings from an on-site agent. The structured spec is composed deterministically; a best-effort multimodal AI identify enriches the name/brand from the measurements when a provider is connected. Built on two GENERIC capabilities the bench app wires together — inventory:create-item + core-scan:identify — not a bench-specific module action. See docs/product/cataloging-bench.md.",
      requires: [{ module: "inventory" }, { module: "core-apps" }, { module: "core-scan" }],
      provides_instances: [
        {
          module: "inventory",
          instance_name: "tooling",
          display_name: "Tooling",
          glyph: "🔧",
          item_noun: "tool",
          qty_unit: "each",
          field_defs: [
            { entity_kind: "inventory:part", name: "tool_type", display_label: "Type", type: "text", position: 1, choices: ["End mill", "Drill", "Tap", "Reamer", "Insert", "Collet", "Other"], help: "What kind of tool — the table groups by this." },
            { entity_kind: "inventory:part", name: "diameter_mm", display_label: "Diameter (mm)", type: "number", position: 2, help: "Cutting diameter, from the calipers." },
            { entity_kind: "inventory:part", name: "shank_dia_mm", display_label: "Shank (mm)", type: "number", position: 3, help: "Shank diameter — the size your collet/holder needs." },
            { entity_kind: "inventory:part", name: "overall_length_mm", display_label: "Overall length (mm)", type: "number", position: 4, help: "Tip to end — for reach + holder clearance." },
            { entity_kind: "inventory:part", name: "flute_length_mm", display_label: "Flute length (mm)", type: "number", position: 5, help: "Length of cut." },
            { entity_kind: "inventory:part", name: "flute_count", display_label: "Flutes", type: "number", position: 6, help: "Number of flutes / lands." },
            { entity_kind: "inventory:part", name: "end_type", display_label: "End", type: "text", position: 7, choices: ["Square", "Ball", "Corner-radius", "Chamfer", "Drill point"], help: "Geometry of the cutting end." },
            { entity_kind: "inventory:part", name: "material", display_label: "Material", type: "text", position: 8, choices: ["Carbide", "HSS", "Cobalt", "Other"], help: "What the tool is made of." },
            { entity_kind: "inventory:part", name: "coating", display_label: "Coating", type: "text", position: 9, choices: ["Uncoated", "TiN", "TiCN", "TiAlN", "AlTiN", "DLC", "Other"], help: "Surface coating, if any." },
            { entity_kind: "inventory:part", name: "weight_g", display_label: "Weight (g)", type: "number", position: 10, help: "From the scale — helps the AI tell carbide from HSS." },
            { entity_kind: "inventory:part", name: "bin", display_label: "Bin", type: "text", position: 11, help: "Where it physically lives — “Bin 1 / Comp 6”. Set at the bench." },
          ],
          field_overrides: [
            { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
            { entity_kind: "inventory:part", name: "category", hidden: true },
            { entity_kind: "inventory:part", name: "location", hidden: true },
            { entity_kind: "inventory:part", name: "warranty", hidden: true },
            { entity_kind: "inventory:part", name: "min_qty", hidden: true },
            { entity_kind: "inventory:part", name: "supplier_url", hidden: true },
            { entity_kind: "inventory:part", name: "serial_number", hidden: true },
            { entity_kind: "inventory:part", name: "model_number", hidden: true },
          ],
          saved_views: [
            { entity_kind: "inventory:part", name: "By type", view_type: "table", pinned: true, config: { group_by: "tool_type", visible_fields: ["title", "diameter_mm", "flute_count", "end_type", "material", "bin"] } },
            { entity_kind: "inventory:part", name: "By bin", view_type: "table", config: { group_by: "bin", visible_fields: ["title", "tool_type", "diameter_mm", "material"] } },
          ],
        },
      ],
      // The guided capture app — a Tier-B custom block reading nothing and
      // committing via inventory:bench-commit. See web/src/lib/bench-app.ts.
      provides_apps: [
        {
          slug: "cataloging-bench",
          name: "Cataloging Bench",
          icon: "🔧",
          pages: [
            { slug: "bench", title: "The bench", blocks: [{ type: "custom", html: CATALOGING_BENCH_HTML, height: 720 }] },
          ],
        },
      ],
    },
  },
];

/** The CURRENT label a bundle declares for a next-step `path`. Setup cards are
 *  cached in localStorage at install time, so a copy change to a next_steps
 *  label wouldn't otherwise reach an existing card — the renderer prefers this
 *  live label over the cached one (matched by path). */
let _nextStepLabelByPath: Map<string, string> | null = null;
export function liveNextStepLabel(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (!_nextStepLabelByPath) {
    _nextStepLabelByPath = new Map();
    for (const b of FEATURED_BUNDLES) {
      for (const s of b.next_steps ?? []) if (s.path) _nextStepLabelByPath.set(s.path, s.label);
      for (const f of b.manifest.features ?? [])
        for (const s of f.next_steps ?? []) if (s.path) _nextStepLabelByPath.set(s.path, s.label);
    }
  }
  return _nextStepLabelByPath.get(path);
}
