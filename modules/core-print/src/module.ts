// core-print — send a document to a print MANAGER (CUPS today), track the job.
//
// The domain-neutral printing capability. A label printer (Rollo), a shipping-
// label printer, an office laser — none are "fabrication" (digifab) and none are
// strictly "QR labels" (labels' QR half); they're just printers fronted by a
// print manager. core-print owns the connection to that manager + the
// send-a-document contract; CONTENT modules (labels, purchases shipping, …) and
// users submit a document to a configured printer.
//
// Coordinate-not-control (read-direction sibling included): Cobblr hands the
// manager a discrete job; it never live-drives the device. CUPS is reached over
// IPP; a `mock` driver backs tests + dev. Direct-to-LAN for self-hosted; the
// same driver rides the edge-bridge for cloud (see
// docs/architecture/device-connectivity.md). First concrete step toward the
// principled `core-devices` substrate — see docs/modules/core-print.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-print",
  version: "0.1.1",
  displayName: "Printing",
  description:
    "Send documents to a print manager (CUPS/IPP). Configure a printer once, then any module or user can print to it. Direct on your LAN, or, on a hosted Cobblr, through an on-site edge bridge.",
  icon: "printer",
  band: "stock",
  autoEnable: false, // opt-in: a workspace turns it on when it has a printer

  schema: {
    tablePrefix: "core_print_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // Register the background dispatch worker once at boot: a core-queue worker that
  // prints an enqueued document to a printer with retry/backoff — the server-side
  // firing path for label auto-flush (D8). Same dynamic-import shape as `api`.
  lifecycle: {
    onBoot: async () => {
      const { registerDispatchWorker } = await import("./dispatch-worker.js");
      registerDispatchWorker();
      const { registerLiveCapabilities } = await import("./live.js");
      registerLiveCapabilities();
    },
  },

  intents: [],
  dependencies: [],

  // AI-REACH: no kinds/actions of its own by design — printing is reached through
  // the labels module's labels:print action, which is the surface a person
  // actually asks for ("print a label for this"). This module is the driver
  // layer underneath (CUPS, Bluetooth, edge), not a thing to ask about.

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: ["core-print.job.submitted", "core-print.job.failed"],
    api: [],
    actions: [],
  },

  subscribes: [],
});
