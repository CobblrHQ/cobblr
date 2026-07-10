// digifab — Digital Fabrication. Connect to the software that runs your
// machines (FDM Monster, OctoPrint, …), send a file to be made, and track
// the job to completion. Server-to-server over the machine manager's REST
// API — it sends files, it never drives hardware (coordinate-not-control).
// The driver layer (MachineDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "digifab",
  version: "0.34.0",
  displayName: "Digital Fabrication",
  description:
    "Send a design file to the software that runs your machine — FDM Monster, OctoPrint, and friends — and track the job to completion. Map a manager's printers to your machines and route files to them. Talks to each manager's REST API; it sends files, it never drives the hardware.",
  icon: "printer",
  band: "stock",
  // An operator, not a trackable kind: digifab acts ON machines (sends
  // files to their managers). Keeps it out of the funnel's "track a
  // kind of thing" column — what-to-do-funnel.md option (c).
  operatesOn: ["machines"],

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
      // Background warmer for the printer file cache — a self-perpetuating queue
      // loop that keeps each printer's file list + thumbnails warm in the DB, so
      // the UI reads warm data and the machine is never hit on a modal open.
      const { registerFileWarmer } = await import("./printer-file-cache.js");
      registerFileWarmer();
      // Live Bambu cloud telemetry — holds an MQTT subscription per cloud Bambu
      // account and writes real-time temps/progress into digifab_bambu_status.
      const { startBambuPump } = await import("./bambu-pump.js");
      startBambuPump();
      // AI print-failure watch — samples each printing device's camera, folds a
      // failure score, auto-pauses + alerts when it crosses the threshold.
      const { registerFailureWatcher } = await import("./failure-detect.js");
      registerFailureWatcher();
    },
  },

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [
      {
        // AI-CRUD: no create — jobs are created by the send-to-machine flow
        // (file + machine + driver), not a generic POST.
        id: "digifab:job",
        updateEndpoint: "/jobs/{id}",
        deleteEndpoint: "/jobs/{id}",
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

  contributes: {
    // UI presence on the module digifab OPERATES ON (gated by operatesOn —
    // the manifest schema rejects a panel targeting an undeclared module).
    // Components live in web/src/panels/registry.tsx under these ids; the
    // machines pages render them generically, never naming digifab.
    panels: [
      // "Just my 3D printers, live" — the scoped fleet floor as a page tab
      // on every machines collection (3D Printers, Laser Cutters, …).
      { id: "digifab:fleet-tab", surface: "module-page-tab" as const, target: "machines", title: "Fleet" },
      // The per-machine cockpit half: link THIS machine to its manager +
      // live status, inside the machine's own detail modal.
      { id: "digifab:cockpit", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Print manager" },
    ],
  },

  exposes: {
    events: [
      "digifab.connection.created",
      "digifab.connection.tested",
      "digifab.connection.updated",
      "digifab.connection.deleted",
      "digifab.job.sent",
      // Fired on send when the job is linked to a build (BoM). Carries
      // { buildId, qty } so a seeded builds wire consumes the components from
      // inventory + bumps the output part. Idempotent (once per job) — the
      // "job-in → subtract inventory → queue the machine" path.
      "digifab.job.build_committed",
      // The reversal twin: a committed build whose job then failed / was
      // cancelled / was scrapped at the bed-clear verdict. Carries the same
      // { buildId, qty } (+ reason) so the seeded builds wire puts the
      // components back and removes the never-made output credit.
      "digifab.job.build_reversed",
      // Print-lifecycle notifications (the "post updates to Discord" flow): a
      // user routes these to a channel at /me/notification-channels.
      // (digifab.connection.synced / print.started / print.progress were
      //  declared but never emitted — removed so the wires UI doesn't offer
      //  dead triggers; re-add with the emit when the poll loop wires them.
      //  Audit 2026-06-26 follow-up.)
      "digifab.print.completed",
      "digifab.print.failed",
      // AI failure watch tripped: the print was auto-paused (or flagged) — routes
      // to the notification channels like the other print.* events.
      "digifab.print.failure_suspected",
      // F-13 — the human's bed-clear verdict. `completed` fires the cheap,
      // reversible effects (filament deduct, usage accrual) immediately; the
      // consequential one (closing the linked task) waits for `confirmed`.
      // `reversed` fires on a "scrapped" verdict to undo the optimistic effects.
      "digifab.print.confirmed",
      // A production run hit its target (all plates verdicted good). Carries
      // { runId, name, targetQty, completedQty, linkedBuildId } — wire it to
      // notifications ("the 250 brackets are done") or downstream stock moves.
      "digifab.run.completed",
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
        appliesTo: { traits: ["physical"] },
        invokeHandler: "digifab.run-command",
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});
