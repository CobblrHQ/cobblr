// core-templates — per-workspace entity templates.
//
// Save a set of default values + tags against a target entity kind;
// stamp out new entities pre-filled from that template. Closes the
// "Tier 2: entity templates" item from
// docs/product/homebox-parity-report.md.
//
// Use cases:
//   - Household appliance template: insured=true, lifetime_warranty
//     defaults to false, archived=false, room=null. Stamping out a
//     new appliance starts with the right shape — user only fills
//     name + model + serial.
//   - "New Voron printer" template on machines:machine — family =
//     Voron, state = building, manufacturer = ...
//   - "Lego set acquired" template on inventory:part — pre-set
//     tags = [lego, new-arrival], status = unbuilt.
//
// Stock band. Inert in workspaces that don't define any templates.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-templates",
  version: "0.1.0",
  displayName: "Templates",
  description:
    "Per-workspace entity templates — pre-fill defaults + tags when stamping out a new part / machine / asset / project.",
  icon: "copy-plus",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_templates_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-templates.template.created",
      "core-templates.template.updated",
      "core-templates.template.deleted",
      "core-templates.template.instantiated",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
