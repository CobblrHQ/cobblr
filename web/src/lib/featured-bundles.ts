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
      "3D printer parts — track manufacturer, voltage, datasheet URL, and a print-label template tuned for narrow bin labels.",
    manifest: {
      id: "cobblr.community.printer-parts",
      version: "0.1.0",
      name: "3D Printer Parts",
      description: "Datasheet-aware part fields + a narrow-bin label template.",
      author: "Cobblr community",
      requires: [{ module: "inventory" }, { module: "labels" }],
      wires: [
        {
          source_kind: "inventory:part",
          action_id: "labels:print",
          trigger_type: "user-invoked",
          template: "{{name}}\n{{voltage | default: \"\"}}{{voltage | default: \"\"}}",
        },
      ],
      field_defs: [
        { entity_kind: "inventory:part", name: "manufacturer", display_label: "Manufacturer", type: "text", position: 1 },
        { entity_kind: "inventory:part", name: "voltage", display_label: "Voltage", type: "text", position: 2 },
        { entity_kind: "inventory:part", name: "datasheet_url", display_label: "Datasheet URL", type: "url", position: 3 },
        { entity_kind: "inventory:part", name: "footprint", display_label: "Footprint / mount", type: "text", position: 4 },
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
];
