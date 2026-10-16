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
  version: "0.2.0",
  displayName: "Printing",
  description:
    "Print documents and labels to your printers, at home or through an on-site bridge.",
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

  dependencies: [],

  // AI-REACH: no kinds by design — printing is reached through the labels
  // module's labels:print action, which is the surface a person actually asks
  // for ("print a label for this"). This module is the driver layer underneath
  // (CUPS, Bluetooth, edge); the one thing to ask it directly is whether a
  // printer is there (core-print:test-printer).

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: ["core-print.job.submitted", "core-print.job.failed"],
    actions: [
      {
        group: "label",
        // UI-SCREEN: /configuration/print
        id: "core-print:test-printer",
        runBy: "member",
        examples: ["is the label printer online", "check the Zebra is connected"],
        label: "Check a printer",
        description: "Ask a label or document printer whether it is reachable and ready, without printing anything. Says what it answered.",
        scope: "workspace",
        invokeHandler: "core-print.test-printer",
        userInvokable: true,
        argsSchema: {
          printer: { label: "Which printer (its name; empty: the default one)", type: "text" },
        },
      },
    ],
  },

  subscribes: [],
});
