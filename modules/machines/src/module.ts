// Machines — generic base module for "physical things I own that
// do something on their own." 3D printers, laser cutters, CNC
// machines all flow through here; type-specific fields come from
// Pillar-E specialisation modules.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "machines",
  version: "0.1.0",
  displayName: "Machines",
  description:
    "Physical machines you own. The base layer — install a specialisation (3D Printers / Laser Cutters / CNC Machines) for type-specific fields.",
  icon: "wrench",

  schema: {
    tablePrefix: "machines_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "machines:machine",
        displayName: "Machine",
        displayNamePlural: "Machines",
        icon: "wrench",
        profile: "owned-thing" /* physical · unique · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "short_name", type: "text" },
          { name: "family", type: "text" },
          { name: "type", type: "text" },
          { name: "manufacturer", type: "text" },
          { name: "state", type: "text" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
        ],
      },
    ],
  },

  intents: [
    { name: "add_machine", description: "Add a new machine" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "machines.machine.created",
      "machines.machine.updated",
      "machines.machine.state_changed",
      "machines.machine.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
