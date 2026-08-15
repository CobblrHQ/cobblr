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
    "Service history + scheduled maintenance for any entity. Oil changes, firmware flashes, warranty renewals: log what's done, get pinged when something's due.",
  icon: "wrench-screwdriver",
  // Capability, not foundational: the platform runs fine without it (nothing
  // depends on it — it just surfaces an opt-in Maintenance panel on entities).
  // `autoEnable` keeps it on for every workspace as before, but `stock` means a
  // workspace that doesn't want it can now turn it off (foundational can't be).
  band: "stock",
  autoEnable: true,

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Maintenance",
    route: "/maintenance",
    icon: "wrench",
  },

  schema: {
    tablePrefix: "core_maintenance_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  // AI-REACH: no kinds by design (entries hang off the entity they service
  // rather than standing alone in nav). Read through the shared registry's
  // list_maintenance tool, which filters at the source (kind=scheduled,
  // due_within_days) so "what is due" is answered without paging everything.

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-maintenance.entry.created",
      "core-maintenance.entry.updated",
      "core-maintenance.entry.deleted",
      "core-maintenance.entry.due-soon",
      // (removed core-maintenance.entry.overdue — declared but never emitted;
      //  the sweeper only emits due-soon. Audit 2026-06-26 follow-up.)
    ],
    api: ["sweep"],
    actions: [],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      const { startMaintenanceSweeper } = await import("./sweeper.js");
      startMaintenanceSweeper();
      const { registerMaintenanceContext } = await import("./computed-context.js");
      registerMaintenanceContext();
      const { registerMaintenanceCalendarSource } = await import("./calendar-source.js");
      registerMaintenanceCalendarSource();
    },
    onShutdown: async () => {
      const { stopMaintenanceSweeper } = await import("./sweeper.js");
      stopMaintenanceSweeper();
    },
  },
});
