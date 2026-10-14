// Assets — generic module for "physical things I own that DON'T
// act on their own": appliances, hand tools, vinyl records, etc.
// Sibling to machines:machine (things that do act) and
// inventory:part (fungible stock).

import { defineModule } from "@cobblr/platform-contract";
import { DISPOSITIONS, DISPOSITION_LABELS } from "@cobblr/platform-contract/disposition";

export default defineModule({
  name: "assets",
  version: "0.6.3",
  displayName: "Assets",
  description:
    "Keep track of the things you own one at a time: tools, appliances, collections, anything worth knowing about individually.",
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
        primary: true,
        // Its category is its own `type` field ("Type / category" on the
        // form): the scan category axis answers from it, not a second field.
        categoryField: "type",
        listEndpoint: "/assets",
        createEndpoint: "/assets",
        updateEndpoint: "/assets/{id}",
        deleteEndpoint: "/assets/{id}",
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
          // In the order a thing lives them, so a board grouped by state reads
          // as its life and keeps a column for an empty state. How it LEFT is
          // the shared disposition vocabulary, the words machines and an
          // import's Fate column use.
          {
            name: "state",
            type: "text",
            choices: ["working", "needs repair", "broken", "in storage", ...DISPOSITIONS.map((d) => DISPOSITION_LABELS[d]), "retired"],
          },
          { name: "serial_number", type: "text", fieldRole: "identifier" }, // VOCAB-ENUMERATION OK: declares what this field means
          // The record's own acquisition fields carry their roles, so a
          // receipt or bill of sale fills them by meaning (#4523).
          // VOCAB-ENUMERATION OK: a manifest declares what each of its fields means.
          { name: "purchased_at", type: "date", fieldRole: "acquired-on" },
          { name: "purchase_price_cents", type: "number", money: "cents", label: "Paid", fieldRole: "acquired-for" }, // VOCAB-ENUMERATION OK: declares what this field means
          { name: "vendor", type: "text", label: "Bought from", fieldRole: "acquired-from" },
          { name: "warranty_until", type: "date" },
          { name: "last_service_at", type: "date", label: "Last service" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
          // Where the asset lives (core-locations ref) — declared so it can be
          // exposed below, mirroring inventory:part.
          { name: "location_id", type: "text" },
          // Where it is, by name: its place, or what it is inside ("Backpack,
          // in Desk drawer"). Derived on read, so a search or the assistant can
          // say where it is.
          { name: "location_name", type: "text", readOnly: true },
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
          "location_name",
          // What was paid: exposable so the assistant and views can answer
          // "what did the van cost", gated below like a part's cost.
          "purchase_price_cents",
          "vendor",
        ],
        // Only viewers granted `assets:view-costs` see the price (admins and
        // owners see everything), the same tier a part's cost sits behind.
        fieldReadScopes: {
          purchase_price_cents: "assets:view-costs",
        },
        detailRoute: "/assets/{id}",
      },
    ],
  },

  // Who has it now: anyone on the workspace's People list. The `assignee`
  // role is that meaning, and wears the Lending face.
  contributes: {
    fieldDefs: [
      { entity_kind: "assets:asset", name: "assigned_to", display_label: "Who has it", type: "person" as const, field_role: "assignee" as const }, // VOCAB-ENUMERATION OK: declares what this field means
      // When a lent thing is due back: a date named like a deadline, so Needs
      // you raises it once it is overdue with no code of its own.
      { entity_kind: "assets:asset", name: "due_back", display_label: "Due back", type: "date" as const },
    ],
  },

  dependencies: [],

  exposes: {
    events: [
      "assets.asset.created",
      // Fired by core-recurrence on a recurring asset's due date (a plant's
      // watering), from the rule this module's resolver hands it.
      "assets.asset.recurred",
      // Emitted on every PATCH with flat before/after field bags, so a
      // transition wire can compare {{event.before.x}} vs {{event.after.x}}
      // (e.g. core-mobility's drift detection).
      "assets.asset.updated",
      "assets.asset.archived",
      "assets.asset.restored",
      "assets.asset.deleted",
      // (removed assets.asset.state_changed / .deleted — declared but never
      //  emitted, so they showed as dead triggers in the wires UI. Re-add
      //  alongside the emit when wired. Audit 2026-06-26 follow-up.)
    ],
    actions: [
      {
        group: "lifecycle",
        id: "assets:lend",
        runBy: "member",
        examples: ["lend the ladder to Sam", "Sam borrowed the drill until Friday", "check the projector out to Robin"],
        label: "Lend it",
        description:
          "Record who has it and when it is due back.",
        face: "lendable",
        appliesTo: { kinds: ["assets:asset"] },
        invokeHandler: "assets.lend",
        undoable: true,
        argsSchema: {
          to: { label: "Who has it", type: "text", required: true, choicesFrom: "people" },
          due_back: { label: "Due back", type: "date", ask: true },
        },
      },
      {
        group: "lifecycle",
        id: "assets:got-back",
        runBy: "member",
        examples: ["I got the ladder back", "Sam returned the drill", "check it back in"],
        label: "Got it back",
        description: "The thing is back: clears Who has it and Due back.",
        face: "lendable",
        appliesTo: { kinds: ["assets:asset"] },
        invokeHandler: "assets.got-back",
        undoable: true,
        argsSchema: {},
      },
      {
        group: "lifecycle",
        id: "assets:archive",
        runBy: "member",
        examples: ["put the old laptop away", "archive the lawnmower, we sold it"],
        label: "Archive this asset",
        description:
          "Removes it from the register, search and Needs you; you can restore it.",
        appliesTo: { kinds: ["assets:asset"] },
        invokeHandler: "assets.archive",
        undoable: true,
        argsSchema: {},
      },
      {
        group: "lifecycle",
        id: "assets:restore",
        runBy: "member",
        examples: ["bring the laptop back", "restore the lawnmower"],
        label: "Restore to the register",
        description: "Bring an archived thing back into the register, as it was.",
        appliesTo: { kinds: ["assets:asset"] },
        invokeHandler: "assets.restore",
        undoable: true,
        argsSchema: {},
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "lifecycle",
        id: "assets:set-custody",
        runBy: "member",
        label: "Put who had it back",
        description: "The undo of Lend it and Got it back: sets Who has it and Due back to what they were.",
        appliesTo: { kinds: ["assets:asset"] },
        invokeHandler: "assets.set-custody",
        internal: true,
        userInvokable: false,
        argsSchema: {
          assigned_to: { label: "Who had it", type: "text" },
          due_back: { label: "When it was due back", type: "text" },
        },
      },
      {
        group: "organise",
        id: "assets:update-fields",
        runBy: "member",
        examples: ["update the mileage on it", "set a field on that asset"],
        label: "Update an asset's fields",
        description:
          "Set metadata fields on an asset from a wire (the inbound-telemetry shape. Canonical use: an inbound webhook (OBD dongle, Home Assistant, telematics) fires core-integrations.inbound.received and a target:\"none\" wire invokes this with template-rendered args. `asset` (id or name) is the one control arg; every other arg is a metadata field to set ({ asset: \"{{event.body.vehicle}}\", mileage: \"{{event.body.odometer}}\" }). Metadata only) native columns aren't wire-writable.",
        // DELIBERATELY universal: the target:"none" inbound-telemetry shape —
        // the wire fires on webhook events with no entity source; the handler
        // locates the asset from args. Scoping would break that pattern.
        appliesTo: { any: true },
        invokeHandler: "assets.update-fields",
        argsSchema: {
          // Only the control arg is declarable: every OTHER arg is a metadata field
          // name to set, which is open by design (the inbound-telemetry shape).
          asset: { label: "Which asset: its id or its name", type: "text" },
        },
        // Wire-driven (telemetry shape) — not a per-row button.
        userInvokable: false,
      },
      {
        group: "organise",
        id: "assets:field-to-location",
        // ADMIN-ONLY: no page twin: a bundle migration that rewrites every asset in an instance and makes locations
        runBy: "admin",
        examples: ["move the Room field into Location", "turn that place field into real locations"],
        label: "Move a place field into Location",
        description:
          "Bundle-migration engine (the assets mirror of inventory:field-to-location): retire a bundle's bespoke place field (e.g. a 'Location' text field) into the platform's canonical Location: for each asset with a value, find-or-create a matching Location AREA, file the asset into it (location_id), then clear the field. Idempotent + safe: never invents a place, never overwrites an already-filed asset, re-uses an existing same-named area. Args: { field, instance }.",
        // A kind-wide migration (every asset in an instance with that
        // field), not something done TO one asset: workspace scope says so,
        // and the assistant still reaches it through invoke_action (#3378).
        scope: "workspace",
        invokeHandler: "assets.field-to-location",
        // Migration-only: run by the bundle-upgrade flow, never a detail button.
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});
