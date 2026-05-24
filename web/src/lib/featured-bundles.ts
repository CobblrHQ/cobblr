// Featured bundle catalog — manifests embedded in the web app so
// users can one-click install without copy-pasting JSON. Until we
// have a hosted registry, this is the curated list.
//
// Each entry is the raw manifest we'd send to /bundles/install.
// Adding a bundle: drop a JSON manifest in bundles/<name>.json at
// the repo root, then import + push it here.

import type { PlatformBundleManifest } from "./api";

export interface FeaturedBundle {
  manifest: PlatformBundleManifest;
  /** Short blurb shown on the catalog card. */
  blurb: string;
  /** Emoji or single-char glyph for the card. */
  glyph: string;
}

export const FEATURED_BUNDLES: FeaturedBundle[] = [
  {
    glyph: "🧱",
    blurb:
      "Lego set inventory with set ID, year, theme, color, condition, and a label template that prints LEGO-flavored.",
    manifest: {
      id: "cobblr.community.lego",
      version: "0.1.0",
      name: "Lego Collector",
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
        { entity_kind: "inventory:part", name: "set_id", display_label: "Set ID", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "year", display_label: "Release year", type: "number", position: 2 },
        { entity_kind: "inventory:part", name: "theme", display_label: "Theme", type: "text", position: 3 },
        { entity_kind: "inventory:part", name: "color", display_label: "Primary color", type: "text", position: 4 },
        { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 5 },
        { entity_kind: "inventory:part", name: "minifig_count", display_label: "Minifig count", type: "number", position: 6 },
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
      name: "Garden Tracker",
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
    glyph: "🛠️",
    blurb:
      "Mod-on-a-machine workflow — projects with parts-needed / ready / in-progress substate, energy estimate, excitement. Drives the 'Workshop Mods' lens on the Projects page.",
    manifest: {
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
      wires: [],
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
  },
];
