// Featured bundle catalog — manifests embedded in the web app so
// users can one-click install without copy-pasting JSON. Until we
// have a hosted registry, this is the curated list.
//
// Each entry is the raw manifest we'd send to /bundles/install.
// Adding a bundle: drop a JSON manifest in bundles/<name>.json at
// the repo root, then import + push it here.

import type { PlatformBundleManifest } from "./api";

/** A post-install guided step — the "you can now add some yarn" prompt
 *  that shows after a bundle installs, so the user isn't left staring at
 *  a closed modal wondering what changed. */
export interface BundleNextStep {
  /** Button label, e.g. "Add your first yarn". */
  label: string;
  /** Module to navigate to (route segment under /w/<handle>), e.g. "inventory". */
  module: string;
  /** One-line hint under the label. */
  hint?: string;
}

export interface FeaturedBundle {
  manifest: PlatformBundleManifest;
  /** Short blurb shown on the catalog card. */
  blurb: string;
  /** Emoji or single-char glyph for the card. */
  glyph: string;
  /** Post-install guided next steps. When omitted, a generic "go to the
   *  modules this set up" list is derived from the manifest's requires. */
  next_steps?: BundleNextStep[];
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
    glyph: "🧶",
    blurb:
      "A knitter's stash by brand, colorway, fibre, and weight class — tracked by skein, metre, or gram. A grouped 'My stash' view sorts it all by weight.",
    manifest: {
      id: "cobblr.flagship.yarn-stash",
      version: "0.1.0",
      name: "Yarn Stash",
      description:
        "Turn inventory into a yarn stash: brand/colorway/fibre/weight, tracked by skein·metre·gram, with a grouped 'My stash' view.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "color", display_label: "Color", type: "text", position: 1, renderer: "color-hex" },
        { entity_kind: "inventory:part", name: "colorway", display_label: "Colorway", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "fiber", display_label: "Fibre", type: "text", position: 3, choices: ["Wool", "Merino", "Cotton", "Acrylic", "Nylon", "Chenille", "Alpaca", "Silk", "Linen", "Bamboo", "Cashmere", "Blend"] },
        { entity_kind: "inventory:part", name: "weight_class", display_label: "Weight", type: "text", position: 4, choices: ["Lace", "Fingering", "Sport", "DK", "Worsted", "Aran", "Bulky", "Super Bulky"] },
        { entity_kind: "inventory:part", name: "vendor", display_label: "Vendor", type: "text", position: 5, choices: ["Michaels", "Hobby Lobby", "Walmart", "Joann", "Amazon", "Etsy", "Local yarn shop"] },
        { entity_kind: "inventory:part", name: "length_per_skein", display_label: "Length / skein (m)", type: "number", position: 6 },
        { entity_kind: "inventory:part", name: "dye_lot", display_label: "Dye lot", type: "text", position: 7 },
        { entity_kind: "inventory:part", name: "hook_size", display_label: "Hook / needle", type: "text", position: 8 },
        { entity_kind: "inventory:part", name: "for_project", display_label: "For project", type: "text", position: 9 },
        { entity_kind: "inventory:part", name: "stash_summary", display_label: "Summary", type: "computed", position: 10, template: '{{weight_class}} {{fiber}} · {{length_per_skein | default: "?"}} m/skein' },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
        { entity_kind: "inventory:part", name: "cost", display_label: "Price / skein" },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "My yarn stash", view_type: "table", pinned: true, config: { group_by: "weight_class", visible_fields: ["title", "color", "colorway", "fiber", "vendor", "qty", "unit", "length_per_skein"] } },
      ],
    },
  },
  {
    glyph: "🧶🪝",
    blurb:
      "A full crochet/knitting studio: your yarn + hook stash, your designs as projects (each with its pattern), with yarn allocated to each design — reserved while you work it, used up when it's finished. Out-of-stock yarn lands on your shopping list; scan a skein or receipt to add it.",
    next_steps: [
      { label: "Add your first yarn", module: "inventory", hint: "Colour, fibre, weight, length — start your stash." },
      { label: "Add a design", module: "projects", hint: "Each design holds its pattern and the yarn it needs." },
    ],
    manifest: {
      id: "cobblr.flagship.yarn-studio",
      version: "0.1.0",
      name: "Yarn Studio",
      description:
        "Designs as projects (pattern file/link + category), a yarn stash + hooks, and yarn allocated per design — reserved while open, consumed when finished. Out-of-stock yarn auto-adds to a shopping list. Scan skeins/hooks/receipts to stock them.",
      author: "Cobblr",
      requires: [
        { module: "projects" },
        { module: "inventory" },
        { module: "lists" },
        { module: "core-scan" },
        { module: "purchases" },
      ],
      field_defs: [
        // ── Yarn (inventory:part) — positions 1-6 show as stash columns ──
        { entity_kind: "inventory:part", name: "color", display_label: "Color", type: "text", position: 1, renderer: "color-hex" },
        { entity_kind: "inventory:part", name: "colorway", display_label: "Colorway", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "fiber", display_label: "Fibre", type: "text", position: 3, choices: ["Wool", "Merino", "Cotton", "Acrylic", "Nylon", "Chenille", "Alpaca", "Silk", "Linen", "Bamboo", "Cashmere", "Blend"] },
        { entity_kind: "inventory:part", name: "weight_class", display_label: "Weight", type: "text", position: 4, choices: ["Lace", "Fingering", "Sport", "DK", "Worsted", "Aran", "Bulky", "Super Bulky"] },
        { entity_kind: "inventory:part", name: "vendor", display_label: "Vendor", type: "text", position: 5, choices: ["Michaels", "Hobby Lobby", "Walmart", "Joann", "Amazon", "Etsy", "Local yarn shop"] },
        { entity_kind: "inventory:part", name: "length_per_skein", display_label: "Length / skein (m)", type: "number", position: 6 },
        // ── Hooks (inventory:part, category "Hooks") — positions 20+ so the
        //    stash table's column cap keeps them off the yarn list; they show
        //    on the hook detail + the Hooks view. Track stock as qty. ──
        { entity_kind: "inventory:part", name: "hook_gauge", display_label: "Hook gauge", type: "text", position: 20, choices: ["1.0 mm", "1.5 mm", "2.0 mm", "2.5 mm", "3.0 mm", "3.5 mm", "4.0 mm", "4.5 mm", "5.0 mm", "5.5 mm", "6.0 mm", "6.5 mm", "7.0 mm", "8.0 mm", "9.0 mm", "10.0 mm"] },
        { entity_kind: "inventory:part", name: "hook_material", display_label: "Hook material", type: "text", position: 21, choices: ["All-metal", "Metal + silicone grip"] },
        // ── Designs (projects:project) ──
        { entity_kind: "projects:project", name: "pattern_url", display_label: "Pattern link", type: "url", position: 1, renderer: "url-link" },
        { entity_kind: "projects:project", name: "pattern_category", display_label: "Category", type: "text", position: 2, choices: ["Wearables", "Toys", "Home-wear", "Blankets"] },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
        { entity_kind: "inventory:part", name: "cost", display_label: "Price / skein" },
      ],
      saved_views: [
        { entity_kind: "projects:project", name: "Designs", view_type: "table", pinned: true, config: { group_by: "pattern_category", visible_fields: ["title", "pattern_category", "status", "pattern_url"] } },
        { entity_kind: "inventory:part", name: "My yarn stash", view_type: "table", pinned: true, config: { group_by: "weight_class", visible_fields: ["title", "color", "colorway", "fiber", "vendor", "qty", "unit", "length_per_skein"] } },
        { entity_kind: "inventory:part", name: "Hooks", view_type: "table", config: { group_by: "hook_material", visible_fields: ["title", "hook_gauge", "hook_material", "qty"] } },
      ],
      wires: [
        // Out-of-stock yarn → shopping list (same primitive as the kitchen bundle).
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
      ],
    },
  },
  {
    glyph: "🖨️🧵",
    blurb:
      "The 3D-printer sibling of Yarn Stash — spools by material, colour, and diameter, weighed in grams, grouped by material, with the print temps that worked.",
    manifest: {
      id: "cobblr.flagship.filament-stash",
      version: "0.1.0",
      name: "Filament Stash",
      description: "Track 3D-printer filament: material/colour/diameter, weighed in grams, grouped by material, with print temps.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "material", display_label: "Material", type: "text", position: 1, choices: ["PLA", "PLA+", "PETG", "ABS", "ASA", "TPU", "Nylon", "PC", "PVA", "Other"] },
        { entity_kind: "inventory:part", name: "color", display_label: "Colour", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "diameter", display_label: "Diameter", type: "text", position: 3, choices: ["1.75 mm", "2.85 mm"] },
        { entity_kind: "inventory:part", name: "length_per_spool", display_label: "Length / spool (m)", type: "number", position: 4 },
        { entity_kind: "inventory:part", name: "spool_weight", display_label: "Empty spool (g)", type: "number", position: 5 },
        { entity_kind: "inventory:part", name: "nozzle_temp", display_label: "Nozzle °C", type: "number", position: 6 },
        { entity_kind: "inventory:part", name: "bed_temp", display_label: "Bed °C", type: "number", position: 7 },
        { entity_kind: "inventory:part", name: "needs_drying", display_label: "Needs drying", type: "boolean", position: 8 },
        { entity_kind: "inventory:part", name: "spool_summary", display_label: "Summary", type: "computed", position: 9, template: '{{material}} {{color}} · {{diameter}} · {{nozzle_temp | default: "?"}}/{{bed_temp | default: "?"}} °C' },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
        { entity_kind: "inventory:part", name: "cost", display_label: "Price / spool" },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "My filament", view_type: "table", pinned: true, config: { group_by: "material", visible_fields: ["title", "color", "diameter", "qty", "unit", "nozzle_temp"] } },
      ],
    },
  },
  {
    glyph: "🏠",
    blurb:
      "Photograph and value what you own, room by room, so a fire/theft/move starts from a real list. A 'By room' view totals the shelf.",
    manifest: {
      id: "cobblr.flagship.home-inventory",
      version: "0.1.0",
      name: "Home Inventory (insurance)",
      description: "Photograph + value belongings room by room for an insurer; grouped 'By room' view.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "room", display_label: "Room", type: "text", position: 1, choices: ["Living room", "Kitchen", "Primary bedroom", "Bedroom", "Bathroom", "Office", "Garage", "Basement", "Attic", "Outdoor", "Storage"] },
        { entity_kind: "inventory:part", name: "replacement_value", display_label: "Replacement value", type: "number", position: 2 },
        { entity_kind: "inventory:part", name: "purchased_from", display_label: "Bought from", type: "text", position: 3 },
        { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchased", type: "date", position: 4 },
        { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 5, choices: ["New", "Excellent", "Good", "Fair", "Poor"] },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Make / brand" },
        { entity_kind: "inventory:part", name: "model_number", display_label: "Model" },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "By room", view_type: "table", pinned: true, config: { group_by: "room", visible_fields: ["title", "replacement_value", "condition", "purchase_date"] } },
      ],
    },
  },
  {
    glyph: "🧾",
    blurb:
      "Snap a receipt at purchase and never miss a warranty or return window. Tracks where/when you bought it, warranty + return-by dates, serial.",
    manifest: {
      id: "cobblr.flagship.warranties-receipts",
      version: "0.1.0",
      name: "Warranties & Receipts",
      description: "Skin inventory's warranty fields into an appliance/electronics tracker with purchase + return-by dates.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "purchased_from", display_label: "Bought from", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "purchase_date", display_label: "Purchased", type: "date", position: 2 },
        { entity_kind: "inventory:part", name: "return_by", display_label: "Return by", type: "date", position: 3 },
        { entity_kind: "inventory:part", name: "category", display_label: "Category", type: "text", position: 4, choices: ["Appliance", "Electronics", "Tools", "Furniture", "Vehicle", "Other"] },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Make / brand" },
        { entity_kind: "inventory:part", name: "model_number", display_label: "Model" },
        { entity_kind: "inventory:part", name: "cost", display_label: "Paid" },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "Warranties", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "purchase_date", "return_by"] } },
      ],
    },
  },
  {
    glyph: "💊",
    blurb:
      "What to take, the dose and schedule, and how many refills are left before you call the pharmacy. Caregiver-friendly; a 'Current meds' view.",
    manifest: {
      id: "cobblr.flagship.medications",
      version: "0.1.0",
      name: "Medications & Refills",
      description: "Track each medication's dose, schedule, prescriber/pharmacy, refills left, and a refill-by date.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "dose", display_label: "Dose", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "schedule", display_label: "Schedule", type: "text", position: 2, choices: ["Once daily", "Twice daily", "Three times daily", "Every morning", "Every night", "As needed", "Weekly"] },
        { entity_kind: "inventory:part", name: "form", display_label: "Form", type: "text", position: 3, choices: ["Tablet", "Capsule", "Liquid", "Injection", "Inhaler", "Topical", "Drops"] },
        { entity_kind: "inventory:part", name: "prescriber", display_label: "Prescriber", type: "text", position: 4 },
        { entity_kind: "inventory:part", name: "pharmacy", display_label: "Pharmacy", type: "text", position: 5 },
        { entity_kind: "inventory:part", name: "rx_number", display_label: "Rx number", type: "text", position: 6 },
        { entity_kind: "inventory:part", name: "refills_left", display_label: "Refills left", type: "number", position: 7 },
        { entity_kind: "inventory:part", name: "refill_by", display_label: "Refill by", type: "date", position: 8 },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Maker" },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "Current meds", view_type: "table", pinned: true, config: { visible_fields: ["title", "dose", "schedule", "refills_left", "refill_by"] } },
      ],
    },
  },
  {
    glyph: "🪴",
    blurb:
      "Stop killing your houseplants — light and watering needs per plant, grouped by light so the windowsill crowd sits apart from the shady corner.",
    manifest: {
      id: "cobblr.flagship.plant-care",
      version: "0.1.0",
      name: "Plant Care",
      description: "Per-plant species, light, watering interval, and pot size; a 'By light' view.",
      author: "Cobblr",
      requires: [{ module: "assets" }],
      field_defs: [
        { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1 },
        { entity_kind: "assets:asset", name: "light", display_label: "Light", type: "text", position: 2, choices: ["Low", "Medium", "Bright indirect", "Direct sun"] },
        { entity_kind: "assets:asset", name: "water_every_days", display_label: "Water every (days)", type: "number", position: 3 },
        { entity_kind: "assets:asset", name: "last_watered", display_label: "Last watered", type: "date", position: 4 },
        { entity_kind: "assets:asset", name: "pot_size", display_label: "Pot size", type: "text", position: 5 },
        { entity_kind: "assets:asset", name: "care_summary", display_label: "Care", type: "computed", position: 6, template: '{{light | default: "?"}} light · water every {{water_every_days | default: "?"}}d' },
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
  },
  {
    glyph: "🔁",
    blurb:
      "Every streaming service, membership, and recurring bill in one place — a computed per-cycle line + renewal dates, grouped by category.",
    manifest: {
      id: "cobblr.flagship.subscriptions",
      version: "0.1.0",
      name: "Subscriptions & Recurring Bills",
      description: "Recurring charges with cost/cycle, renewal date, payment method; a computed plan line + 'Renews next' view.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "cost_per_cycle", display_label: "Cost / cycle", type: "number", position: 1 },
        { entity_kind: "inventory:part", name: "billing_cycle", display_label: "Billing cycle", type: "text", position: 2, choices: ["Weekly", "Monthly", "Quarterly", "Yearly"] },
        { entity_kind: "inventory:part", name: "renewal_date", display_label: "Renews", type: "date", position: 3 },
        { entity_kind: "inventory:part", name: "category", display_label: "Category", type: "text", position: 4, choices: ["Streaming", "Software", "Membership", "Utility", "Insurance", "Phone / internet", "Other"] },
        { entity_kind: "inventory:part", name: "payment_method", display_label: "Paid with", type: "text", position: 5 },
        { entity_kind: "inventory:part", name: "plan_summary", display_label: "Plan", type: "computed", position: 6, template: '{{cost_per_cycle | default: "?"}} / {{billing_cycle | default: "cycle"}} · renews {{renewal_date | default: "—"}}' },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "supplier_url", display_label: "Manage URL" },
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Provider" },
        { entity_kind: "inventory:part", name: "qty", hidden: true },
        { entity_kind: "inventory:part", name: "unit", hidden: true },
        { entity_kind: "inventory:part", name: "min_qty", hidden: true },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "Renews next", view_type: "table", pinned: true, config: { group_by: "category", visible_fields: ["title", "cost_per_cycle", "billing_cycle", "renewal_date"] } },
      ],
    },
  },
  {
    glyph: "📚",
    blurb:
      "Catalog what you collect — books, wine, records, cards, coins — grouped by condition, with paid-vs-value, so you stop buying the dupe.",
    manifest: {
      id: "cobblr.flagship.collections",
      version: "0.1.0",
      name: "Collections",
      description: "Catalog a collection by condition, edition, paid + current value; a 'By condition' view.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "condition", display_label: "Condition", type: "text", position: 1, choices: ["Mint / Sealed", "Near Mint", "Excellent", "Good", "Fair", "Poor"] },
        { entity_kind: "inventory:part", name: "edition", display_label: "Edition / year", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "acquired_date", display_label: "Acquired", type: "date", position: 3 },
        { entity_kind: "inventory:part", name: "acquired_price", display_label: "Paid", type: "number", position: 4 },
        { entity_kind: "inventory:part", name: "current_value", display_label: "Value today", type: "number", position: 5 },
        { entity_kind: "inventory:part", name: "signed", display_label: "Signed / sealed", type: "boolean", position: 6 },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Maker / label" },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
        { entity_kind: "inventory:part", name: "min_qty", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "By condition", view_type: "table", pinned: true, config: { group_by: "condition", visible_fields: ["title", "edition", "current_value", "acquired_date"] } },
      ],
    },
  },
  {
    glyph: "🪪",
    blurb:
      "Passport, license, registration, insurance — every document that expires, with its number + issuer. Expiry dates land on your calendar automatically.",
    manifest: {
      id: "cobblr.flagship.documents-renewals",
      version: "0.1.0",
      name: "Important Documents & Renewals",
      description: "Documents that expire, with number/issuer/expiry; a 'Renewals' view + automatic calendar reminders.",
      author: "Cobblr",
      requires: [{ module: "assets" }],
      field_defs: [
        { entity_kind: "assets:asset", name: "doc_type", display_label: "Type", type: "text", position: 1, choices: ["Passport", "Driver's license", "Vehicle registration", "Insurance policy", "Membership", "Certification", "Visa / permit", "Warranty", "Other"] },
        { entity_kind: "assets:asset", name: "document_number", display_label: "Number", type: "text", position: 2 },
        { entity_kind: "assets:asset", name: "issuer", display_label: "Issued by", type: "text", position: 3 },
        { entity_kind: "assets:asset", name: "issued_date", display_label: "Issued", type: "date", position: 4 },
        { entity_kind: "assets:asset", name: "expires_date", display_label: "Expires", type: "date", position: 5 },
        { entity_kind: "assets:asset", name: "doc_summary", display_label: "Summary", type: "computed", position: 6, template: '{{doc_type | default: "Document"}} · expires {{expires_date | default: "—"}}' },
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
  },
  {
    glyph: "🐾",
    blurb:
      "Each pet's vitals + schedule — species, breed, birthday, vet, microchip, weight, and next-vet / rabies-due dates that land on your calendar.",
    manifest: {
      id: "cobblr.flagship.pet-care",
      version: "0.1.0",
      name: "Pet Care",
      description: "Per-pet vitals + vet/vaccination dates (calendar-reminded); a 'My pets' view grouped by species.",
      author: "Cobblr",
      requires: [{ module: "assets" }],
      field_defs: [
        { entity_kind: "assets:asset", name: "species", display_label: "Species", type: "text", position: 1, choices: ["Dog", "Cat", "Rabbit", "Bird", "Reptile", "Fish", "Horse", "Other"] },
        { entity_kind: "assets:asset", name: "breed", display_label: "Breed", type: "text", position: 2 },
        { entity_kind: "assets:asset", name: "birthdate", display_label: "Birthday", type: "date", position: 3 },
        { entity_kind: "assets:asset", name: "weight_kg", display_label: "Weight (kg)", type: "number", position: 4 },
        { entity_kind: "assets:asset", name: "vet", display_label: "Vet", type: "text", position: 5 },
        { entity_kind: "assets:asset", name: "microchip", display_label: "Microchip", type: "text", position: 6 },
        { entity_kind: "assets:asset", name: "next_vet_visit", display_label: "Next vet visit", type: "date", position: 7 },
        { entity_kind: "assets:asset", name: "rabies_due", display_label: "Rabies due", type: "date", position: 8 },
      ],
      field_overrides: [
        { entity_kind: "assets:asset", name: "manufacturer", hidden: true },
        { entity_kind: "assets:asset", name: "model", hidden: true },
        { entity_kind: "assets:asset", name: "serial_number", hidden: true },
        { entity_kind: "assets:asset", name: "short_name", hidden: true },
        { entity_kind: "assets:asset", name: "excitement", hidden: true },
      ],
      saved_views: [
        { entity_kind: "assets:asset", name: "My pets", view_type: "table", pinned: true, config: { group_by: "species", visible_fields: ["title", "breed", "weight_kg", "next_vet_visit", "rabies_due"] } },
      ],
    },
  },
  {
    glyph: "🎁",
    blurb:
      "Stash gift ideas year-round — who, what occasion + its date, a link, a budget, and the idea→bought→wrapped→given pipeline. Dates hit your calendar.",
    manifest: {
      id: "cobblr.flagship.gifts-occasions",
      version: "0.1.0",
      name: "Gifts & Occasions",
      description: "Gift ideas by recipient + occasion date (calendar-reminded); a 'By recipient' view + status pipeline.",
      author: "Cobblr",
      requires: [{ module: "inventory" }],
      field_defs: [
        { entity_kind: "inventory:part", name: "recipient", display_label: "For", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "occasion", display_label: "Occasion", type: "text", position: 2, choices: ["Birthday", "Christmas", "Anniversary", "Wedding", "Graduation", "Holiday", "Just because", "Other"] },
        { entity_kind: "inventory:part", name: "occasion_date", display_label: "Occasion date", type: "date", position: 3 },
        { entity_kind: "inventory:part", name: "budget", display_label: "Budget", type: "number", position: 4 },
        { entity_kind: "inventory:part", name: "status", display_label: "Status", type: "text", position: 5, choices: ["Idea", "Bought", "Wrapped", "Given"] },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "supplier_url", display_label: "Idea link" },
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Store" },
        { entity_kind: "inventory:part", name: "cost", display_label: "Spent" },
        { entity_kind: "inventory:part", name: "qty", hidden: true },
        { entity_kind: "inventory:part", name: "unit", hidden: true },
        { entity_kind: "inventory:part", name: "min_qty", hidden: true },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "Gift list", view_type: "table", pinned: true, config: { group_by: "recipient", visible_fields: ["title", "occasion", "occasion_date", "budget", "status"] } },
      ],
    },
  },
  {
    glyph: "🧻",
    blurb:
      "Toiletries / cleaning / batteries hit their reorder level → auto onto the shopping list; check off after shopping → it restocks. Grouped by area.",
    manifest: {
      id: "cobblr.flagship.household-supplies",
      version: "0.1.0",
      name: "Household Supplies auto-reorder",
      description: "Reorder level per supply → auto shopping list on low-stock, restock on check-off; a 'By area' view.",
      author: "Cobblr",
      requires: [{ module: "inventory" }, { module: "lists" }],
      wires: [
        { source_kind: "inventory:part", action_id: "lists:add-item", trigger_type: "event", trigger_event: "inventory.stock.low", args: { listTitle: "Shopping list" } },
        { source_kind: "inventory:part", action_id: "inventory:adjust-stock", trigger_type: "event", trigger_event: "lists.item.checked", args: { delta: 1, reason: "Restocked — checked off the shopping list" } },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "area", display_label: "Area", type: "text", position: 1, choices: ["Bathroom", "Kitchen", "Laundry", "Cleaning", "Garage", "Office", "General"] },
        { entity_kind: "inventory:part", name: "typical_pack", display_label: "Usual pack", type: "text", position: 2 },
      ],
      field_overrides: [
        { entity_kind: "inventory:part", name: "min_qty", display_label: "Reorder at" },
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Brand" },
        { entity_kind: "inventory:part", name: "serial_number", hidden: true },
        { entity_kind: "inventory:part", name: "model_number", hidden: true },
      ],
      saved_views: [
        { entity_kind: "inventory:part", name: "Supplies by area", view_type: "table", pinned: true, config: { group_by: "area", visible_fields: ["title", "qty", "unit", "typical_pack"] } },
      ],
    },
  },
  {
    glyph: "🏡🔧",
    blurb:
      "The home version of Vehicle Maintenance — furnace, water heater, HVAC filters, detectors — with service logs + next-due dates on your calendar.",
    manifest: {
      id: "cobblr.flagship.home-maintenance",
      version: "0.1.0",
      name: "Home Maintenance Schedule",
      description: "Each home system + its service log with cost + next-due dates; a 'Home systems' view grouped by system.",
      author: "Cobblr",
      requires: [{ module: "assets" }, { module: "core-maintenance" }],
      field_defs: [
        { entity_kind: "assets:asset", name: "system_type", display_label: "System", type: "text", position: 1, choices: ["Furnace", "Air conditioner", "Water heater", "HVAC filter", "Smoke / CO detector", "Gutters", "Sump pump", "Dishwasher", "Washer", "Dryer", "Refrigerator", "Garage door", "Other"] },
        { entity_kind: "assets:asset", name: "location", display_label: "Location", type: "text", position: 2 },
        { entity_kind: "assets:asset", name: "installed_date", display_label: "Installed", type: "date", position: 3 },
        { entity_kind: "assets:asset", name: "filter_size", display_label: "Filter / part size", type: "text", position: 4 },
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
        { entity_kind: "assets:asset", name: "Home systems", view_type: "table", pinned: true, config: { group_by: "system_type", visible_fields: ["title", "location", "installed_date", "filter_size"] } },
      ],
    },
  },
];
