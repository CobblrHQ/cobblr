// CNC Machines — Pillar-E specialisation that extends
// machines:machine with CNC-specific custom fields.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "cnc-machines",
  version: "0.1.0",
  displayName: "CNC Machines",
  description:
    "Extends machines with CNC-specific fields: spindle, axis_count, work_area, controller, coolant_type.",
  icon: "wrench",
  band: "user",

  dependencies: ["machines"],

  contributes: {
    fieldDefs: [
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
        choices: ['200×200×80', '300×300×100', '400×400×120', '600×900×150', '1200×1200×200', '1200×2400×200'],
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
    wires: [],
  },

  provides: { entityKinds: [] },
  intents: [],
  exposes: { events: [], api: [], actions: [] },
  subscribes: [],
});
