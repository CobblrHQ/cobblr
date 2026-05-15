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
];
