// digifab — Digital Fabrication. Connect to the software that runs your
// machines (FDM Monster, OctoPrint, …), send a file to be made, and track
// the job to completion. Server-to-server over the machine manager's REST
// API — it sends files, it never drives hardware (coordinate-not-control).
// The driver layer (MachineDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "digifab",
  version: "0.22.0",
  displayName: "Digital Fabrication",
  description:
    "Send a design file to the software that runs your machine — FDM Monster, OctoPrint, and friends — and track the job to completion. Map a manager's printers to your machines and route files to them. Talks to each manager's REST API; it sends files, it never drives the hardware.",
  icon: "printer",
  band: "stock",

  schema: {
    tablePrefix: "digifab_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // Register the auto-poll worker once at boot — a core-queue worker
  // that walks a sent job to its terminal state, re-enqueuing itself
  // until done (no cron). Same dynamic-import shape as `api`.
  lifecycle: {
    onBoot: async () => {
      const { registerPollWorker } = await import("./poll-worker.js");
      registerPollWorker();
      const { registerAssignWorker } = await import("./assign-worker.js");
      registerAssignWorker();
    },
  },

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [
      {
        id: "digifab:job",
        displayName: "Print job",
        displayNamePlural: "Print jobs",
        icon: "printer",
        // A unit of work that queues → prints → completes: digital,
        // unique, completable, durable. Registering it lets the wire
        // composer show digifab:job as a source (e.g. the seeded
        // print.confirmed → mark-task-done binding) and lets other
        // modules look a job up via platform.entities.
        profile: "work-item",
        fields: [
          { name: "file_ref", type: "text", role: "title", required: true },
          { name: "status", type: "text" },
          { name: "target_device", type: "text" },
          { name: "progress", type: "number" },
          { name: "remote_job_id", type: "text" },
        ],
        exposableFields: ["file_ref", "status", "target_device", "progress", "remote_job_id"],
        detailRoute: "/configuration/farm",
      },
    ],
  },

  exposes: {
    events: [
      "digifab.connection.created",
      "digifab.connection.tested",
      "digifab.connection.synced",
      "digifab.connection.deleted",
      "digifab.job.sent",
      // Print-lifecycle notifications (the "post updates to Discord" flow): a
      // user routes these to a channel at /me/notification-channels.
      "digifab.print.started",
      "digifab.print.progress",
      "digifab.print.completed",
      "digifab.print.failed",
      // F-13 — the human's bed-clear verdict. `completed` fires the cheap,
      // reversible effects (filament deduct, usage accrual) immediately; the
      // consequential one (closing the linked task) waits for `confirmed`.
      // `reversed` fires on a "scrapped" verdict to undo the optimistic effects.
      "digifab.print.confirmed",
      "digifab.print.reversed",
      "digifab.driver.installed",
      // The actuator's canonical event is now core-devices.command.sent (the
      // inbound ingest + device.* events also moved). digifab.command.sent stays
      // declared for any pre-existing listeners. digifab now backs
      // platform().devices.getDriver. See modules/core-devices.
      "digifab.command.sent",
    ],
    api: [],
    actions: [
      {
        // DEPRECATED ALIAS. The actuator moved to core-devices (general device
        // I/O, not fabrication). This thin alias delegates to
        // core-devices:run-command so wires in ALREADY-INSTALLED bundles keep
        // working; new bundles should use core-devices:run-command.
        id: "digifab:run-command",
        label: "Run a device command (deprecated → core-devices:run-command)",
        description:
          "Deprecated alias of core-devices:run-command, kept so installed bundle wires keep working. Fires a parameterized command-and-forget at a connected actuator via platform().devices. New wires should target core-devices:run-command.",
        appliesTo: { any: true },
        invokeHandler: "digifab.run-command",
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});
