// core-maintenance — per-entity service log.
//
// Tracks "this was done" and "this is due" for any entity in any
// module. Polymorphic over (entity_module, entity_type, entity_id).
// The killer HomeBox-parity feature: warranty cards + service
// schedules on a household asset, oil-change history on a machine,
// firmware-flash dates on a 3D printer.
//
// Foundational. Other modules don't depend on this directly; the UI
// surfaces a Maintenance panel on entities that opt in.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-maintenance",
  version: "0.1.0",
  displayName: "Maintenance",
  description:
    "Service history + scheduled maintenance for any entity. Oil changes, firmware flashes, warranty renewals — log what's done, get pinged when something's due.",
  icon: "wrench-screwdriver",
  band: "foundational",

  schema: {
    tablePrefix: "core_maintenance_",
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
      "core-maintenance.entry.created",
      "core-maintenance.entry.updated",
      "core-maintenance.entry.deleted",
      "core-maintenance.entry.due-soon",
      "core-maintenance.entry.overdue",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
