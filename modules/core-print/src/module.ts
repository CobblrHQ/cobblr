// core-print — send a document to a print MANAGER (CUPS today), track the job.
//
// The domain-neutral printing capability. A label printer (Rollo), a shipping-
// label printer, an office laser — none are "fabrication" (digifab) and none are
// strictly "QR labels" (core-labels-qr); they're just printers fronted by a
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
  version: "0.1.0",
  displayName: "Printing",
  description:
    "Send documents to a print manager (CUPS/IPP). Configure a printer once, then any module or user can print to it. Direct on the LAN, or via the edge-bridge from cloud.",
  icon: "printer",
  band: "stock",
  autoEnable: false, // opt-in: a workspace turns it on when it has a printer

  schema: {
    tablePrefix: "core_print_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

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
