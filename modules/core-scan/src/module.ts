// core-scan — barcode + photo identification, generalized.
//
// "Point your phone at a thing, end up with a row." Two ingest
// paths (barcode fast path, photo AI path) converge on one inbox.
// User triages from desktop; one tap commits into the chosen
// entity kind (inventory:part, assets:asset, machines:machine,
// future kinds — target picked at confirm time).
//
// v0.1: barcode-only fast path with Open Products Facts + upcitemdb
// inline lookups (both keyless free-tier). Photo AI path, web-
// search fallback, receipt OCR, large-batch bulk confirm: v0.2.
//
// See docs/modules/core-scan.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-scan",
  version: "0.1.0",
  displayName: "Scan",
  description:
    "Scan a barcode or take a photo of a thing; end up with a draft inventory row, pre-filled with the resolved name + brand + catalog photo. One tap to commit.",
  icon: "scan-line",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  // The scan/camera button earns a permanent icon slot in the navbar's
  // right cluster — it's the most-used action for camera-first intake
  // (companion app hits it constantly). Shows only while core-scan is on.
  // One tap → the full-screen scanner with a LIVE camera (companion app parity);
  // the inbox stays reachable via the "Scan" nav entry.
  headerAction: {
    icon: "camera", // a camera, like companion app — it opens a live viewfinder
    label: "Scan",
    route: "/scan/camera",
  },

  schema: {
    tablePrefix: "core_scan_",
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
      "core-scan.scan.received",
      "core-scan.scan.enriched",
      "core-scan.scan.confirmed",
      "core-scan.scan.discarded",
    ],
    api: [],
    actions: [
      {
        id: "core-scan:identify-photo",
        label: "Identify a scanned photo",
        description:
          "Vision-identify a photo-only inbox row (no barcode) into a draft. Wire-fired on scan.received; no-ops for barcode/url scans.",
        appliesTo: { any: true },
        invokeHandler: "core-scan.identify-photo",
        // Wire-only — the autonomous-sort binding fires it, not a button.
        userInvokable: false,
      },
    ],
  },

  // Informational — the reaction runs through the seeded wire below.
  subscribes: ["core-scan.scan.received"],

  // The autonomous photo-sort ships as a default WIRE, not a cron baked
  // into the module: every scan.received fires identify-photo, which
  // vision-identifies photo-only rows detached. Editable / disable-able
  // on /bindings like any wire — Pillar-C consistency over hardcoded
  // automation. source_kind "core-scan:item" → the engine reads the
  // row id from payload.itemId; target defaults to "self".
  contributes: {
    wires: [
      {
        source_kind: "core-scan:item",
        action_id: "core-scan:identify-photo",
        trigger_type: "event",
        trigger_event: "core-scan.scan.received",
      },
    ],
  },
});
