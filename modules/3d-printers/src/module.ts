// 3D Printers — Pillar-E specialisation that extends machines:machine
// with 3D-printer-specific custom fields. Owns no tables of its own.
// When enabled for an org, the platform applies these field-defs
// (tagged source_module='3d-printers') to module_field_defs.
// Disable cleans them up. Same model would apply to user-edited
// forks of this module.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "3d-printers",
  version: "0.1.0",
  displayName: "3D Printers",
  description:
    "Extends machines with 3D-printer-specific fields: hotend, extruder, board, firmware, bed_size, local_ip.",
  icon: "printer",

  dependencies: ["machines"],

  contributes: {
    fieldDefs: [
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
        choices: ['180×180', '200×200', '220×220', '235×235', '250×250', '300×300', '350×350', '400×400'],
      },
      {
        entity_kind: "machines:machine",
        name: "local_ip",
        display_label: "Local IP / hostname",
        type: "text",
        position: 15,
      },
    ],
    wires: [],
  },

  provides: { entityKinds: [] },
  intents: [],
  exposes: { events: [], api: [], actions: [] },
  subscribes: [],
});
