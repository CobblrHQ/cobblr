// Assets — generic module for "physical things I own that DON'T
// act on their own": appliances, hand tools, vinyl records, etc.
// Sibling to machines:machine (things that do act) and
// inventory:part (fungible stock).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "assets",
  version: "0.1.0",
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
        ],
        // Public face. Service / warranty dates may be sensitive in
        // commercial contexts; keep them private to assets' own UI for
        // now. Serial_number stays internal (anti-theft / privacy).
        exposableFields: [
          "name",
          "short_name",
          "manufacturer",
          "model",
          "type",
          "state",
          "image_path",
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
      "assets.asset.state_changed",
      "assets.asset.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
