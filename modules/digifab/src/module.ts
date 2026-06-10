// digifab — Digital Fabrication. Connect to the software that runs your
// machines (FDM Monster, OctoPrint, …), send a file to be made, and track
// the job to completion. Server-to-server over the machine manager's REST
// API — it sends files, it never drives hardware (coordinate-not-control).
// The driver layer (MachineDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "digifab",
  version: "0.1.0",
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
        // print.completed → mark-task-done binding) and lets other
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
      "digifab.print.completed",
      "digifab.print.failed",
      "digifab.driver.installed",
      "digifab.command.sent",
    ],
    api: [],
    actions: [
      {
        id: "digifab:run-command",
        label: "Run a device command",
        description:
          "Fire a parameterized command-and-forget at a connected actuator/controller — open a valve for N seconds, call a Home Assistant service, flip a relay. Wire-invokable: an entity's schedule (e.g. each plant's water_rrule) commands a device with THAT entity's own params (zone, seconds). `connection` + `command` are fixed wire args; the rest are passed through as the command's params.",
        appliesTo: { any: true },
        invokeHandler: "digifab.run-command",
        // Wire-driven (the actuator shape) — not a per-row button.
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});
