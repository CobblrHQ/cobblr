// core-farm — connect a print farm (FDM Monster +), map its printers,
// and (Phase B/C) send + track print jobs. Server-to-server over the
// farm's REST API; routing-aware (fdm-monster/fdm-monster#5303). The
// driver layer (FarmDriver interface + fdm-monster + mock) is in
// ./drivers; this is the connection registry + its HTTP surface.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-farm",
  version: "0.1.0",
  displayName: "Print farm",
  description:
    "Connect a print farm — FDM Monster and friends. Map its printers to your machines, preview where a sliced file will route, and (soon) approve-and-send print jobs with status tracking. Talks to the farm's REST API; no shared folders.",
  icon: "printer",
  band: "stock",

  schema: {
    tablePrefix: "core_farm_",
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
    entityKinds: [],
  },

  exposes: {
    events: [
      "core-farm.connection.created",
      "core-farm.connection.tested",
      "core-farm.connection.synced",
      "core-farm.connection.deleted",
      "core-farm.job.sent",
      "core-farm.print.completed",
      "core-farm.print.failed",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
