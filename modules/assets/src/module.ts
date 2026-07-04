// Assets — generic module for "physical things I own that DON'T
// act on their own": appliances, hand tools, vinyl records, etc.
// Sibling to machines:machine (things that do act) and
// inventory:part (fungible stock).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "assets",
  version: "0.2.0",
  displayName: "Assets",
  description:
    "Physical things you own that aren't fungible stock and aren't machines. Appliances, tools, collections — anything you'd want to track individually.",
  icon: "box",
  band: "stock",
  instanceability: "multi",

  schema: {
    tablePrefix: "assets_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "assets:asset",
        displayName: "Asset",
        displayNamePlural: "Assets",
        icon: "box",
        profile: "owned-thing" /* physical · unique · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "short_name", type: "text" },
          { name: "manufacturer", type: "text" },
          { name: "model", type: "text" },
          { name: "type", type: "text" },
          { name: "state", type: "text" },
          { name: "serial_number", type: "text" },
          { name: "purchased_at", type: "date" },
          { name: "warranty_until", type: "date" },
          { name: "last_service_at", type: "date" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
          // Where the asset lives (core-locations ref) — declared so it can be
          // exposed below, mirroring inventory:part.
          { name: "location_id", type: "text" },
          // Free-form custom-field blob (bundle / user fields). Declared so
          // it can be exposed below — mirrors inventory:part.
          { name: "metadata", type: "object" },
        ],
        // Public face. Service / warranty dates may be sensitive in
        // commercial contexts; keep them private to assets' own UI for
        // now. Serial_number stays internal (anti-theft / privacy).
        // `metadata` (the custom-field blob) is exposed — mirrors
        // inventory:part — so bundle/user custom fields can drive saved
        // views, search, and the calendar. Same opt-in surface, not raw
        // native columns.
        exposableFields: [
          "name",
          "short_name",
          "manufacturer",
          "model",
          "type",
          "state",
          "image_path",
          "metadata",
          // Where the asset lives — same exposure inventory:part grants; feeds
          // location-aware consumers (views, core-mobility's drift rule).
          "location_id",
        ],
        detailRoute: "/assets/{id}",
      },
    ],
  },

  intents: [{ name: "log_asset", description: "Add a thing you own" }],

  dependencies: [],

  exposes: {
    events: [
      "assets.asset.created",
      // Emitted on every PATCH with flat before/after field bags, so a
      // transition wire can compare {{event.before.x}} vs {{event.after.x}}
      // (e.g. core-mobility's drift detection).
      "assets.asset.updated",
      // (removed assets.asset.state_changed / .deleted — declared but never
      //  emitted, so they showed as dead triggers in the wires UI. Re-add
      //  alongside the emit when wired. Audit 2026-06-26 follow-up.)
    ],
    api: [],
    actions: [
      {
        id: "assets:update-fields",
        label: "Update an asset's fields",
        description:
          "Set metadata fields on an asset from a wire — the inbound-telemetry shape. Canonical use: an inbound webhook (OBD dongle, Home Assistant, telematics) fires core-integrations.inbound.received and a target:\"none\" wire invokes this with template-rendered args. `asset` (id or name) is the one control arg; every other arg is a metadata field to set ({ asset: \"{{event.body.vehicle}}\", mileage: \"{{event.body.odometer}}\" }). Metadata only — native columns aren't wire-writable.",
        // DELIBERATELY universal: the target:"none" inbound-telemetry shape —
        // the wire fires on webhook events with no entity source; the handler
        // locates the asset from args. Scoping would break that pattern.
        appliesTo: { any: true },
        invokeHandler: "assets.update-fields",
        // Wire-driven (telemetry shape) — not a per-row button.
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});
