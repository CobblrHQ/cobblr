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
  version: "0.20.2",
  displayName: "Scan",
  description:
    "Scan a barcode or take a photo of a thing; end up with a draft inventory row, pre-filled with the resolved name + brand + catalog photo. One tap to commit.",
  icon: "scan-line",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  // The scan/camera button earns a permanent icon slot in the navbar's
  // right cluster — it's the most-used action for camera-first intake
  // (camera-first intake hits it constantly). Shows only while core-scan is on.
  // One tap → the full-screen scanner with a LIVE camera;
  // the inbox stays reachable via the "Scan" nav entry.
  headerAction: {
    icon: "camera", // opens a live viewfinder
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
      "core-scan.scan.unconfirmed",
      "core-scan.scan.discarded",
      "core-scan.organize.applied",
      "core-scan.putaway.session-started",
      "core-scan.putaway.item-placed",
      "core-scan.putaway.session-ended",
    ],
    api: [],
    // ──────────── Live box — scan-drive session mode ────────────
    // Applicable only when a bridge scanner is connected (a scan from elsewhere
    // can drive THIS screen). Tab-scoped (the follower is this browser tab); the
    // Open/Print segment picks navigate vs print disposition (slice 4). See
    // docs/design-decisions/live-controls.md + scan-drives-screen.md.
    live: [
      {
        id: "core-scan.scan-drive",
        label: "Scans drive this screen",
        icon: "scan-line",
        requires: "scanner.bridge",
        scope: "tab",
        control: "switch-segment",
        segment: [
          { value: "navigate", label: "Open" },
          { value: "print", label: "Print" },
        ],
        detail: "/scan",
        order: 10,
      },
    ],
    actions: [
      {
        id: "core-scan:identify-photo",
        label: "Identify a scanned photo",
        description:
          "Vision-identify a photo-only inbox row (no barcode) into a draft. Wire-fired on scan.received; no-ops for barcode/url scans.",
        // DELIBERATELY universal: fires on scan events, not entity sources —
        // the inbox row in the payload is the subject. Kind/trait scoping
        // would be false precision (see /actions provenance).
        appliesTo: { any: true },
        invokeHandler: "core-scan.identify-photo",
        // Wire-only — the autonomous-sort binding fires it, not a button.
        userInvokable: false,
      },
      {
        id: "core-scan:identify",
        label: "Identify a thing",
        description:
          "PURE 'what is this?' — from a photo and/or captured measurements + observations. Returns the suggestion ({ name, brand, category, confidence }); writes nothing. A capture app calls it and decides whether to use the suggestion or keep its own name. User-invokable. Args: { image_file_id?, measurements?, observations? }.",
        // DELIBERATELY universal: args-driven (a capture app supplies the
        // photo/measurements) — there is no entity source to scope by.
        appliesTo: { any: true },
        invokeHandler: "core-scan.identify",
        userInvokable: true,
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
