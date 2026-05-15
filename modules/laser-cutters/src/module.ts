// Laser Cutters — Pillar-E specialisation that extends
// machines:machine with laser-specific custom fields.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "laser-cutters",
  version: "0.1.0",
  displayName: "Laser Cutters",
  description:
    "Extends machines with laser-cutter-specific fields: tube_type, wattage, bed_size, cooling_type, focal_length.",
  icon: "flame",

  dependencies: ["machines"],

  contributes: {
    fieldDefs: [
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
        name: "bed_size",
        display_label: "Bed size (mm)",
        type: "text",
        position: 22,
        choices: ['200×300', '300×400', '400×600', '500×700', '600×900', '900×1200', '1200×1600'],
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
    wires: [],
  },

  provides: { entityKinds: [] },
  intents: [],
  exposes: { events: [], api: [], actions: [] },
  subscribes: [],
});
