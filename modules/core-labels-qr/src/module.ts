// core-labels-qr — QR code labels + scan-to-action.
//
// Each printed label can carry a QR code that resolves at scan time
// to (workspace, entity) — and either navigates to the entity's
// detail page or fires an action with a confirmation card. See
// docs/modules/core-labels-qr.md.
//
// Stock band. Depends on labels (label templates host the
// `qr_config` block + the `{{qr}}` placeholder) and rides
// core-public-surfaces' cross-tenant token resolution pattern.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-labels-qr",
  version: "0.1.0",
  displayName: "QR Labels",
  description:
    "QR codes on printed labels. Scan with any camera to jump to an entity's detail page or fire an action.",
  icon: "qr-code",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_labels_qr_",
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
      "core-labels-qr.token.created",
      "core-labels-qr.token.revoked",
      "core-labels-qr.scan.received",
      "core-labels-qr.scan.action_invoked",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
