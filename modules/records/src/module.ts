// Records — the neutral generic-record substrate. A record carries ONLY
// the universal base (name, image, notes, location, custom-field bag):
// catalog-like collections (a Bookshelf, a Movies list) become instances
// of this module and declare their own fields, instead of riding on
// assets and inheriting a drill-press's columns.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "records",
  version: "0.1.0",
  displayName: "Records",
  description:
    "A blank-slate collection of records. No built-in domain columns — each collection declares its own fields, so a bookshelf, a movie list, or a recipe box starts clean.",
  icon: "album",
  band: "stock",
  instanceability: "multi",

  schema: {
    tablePrefix: "records_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "records:record",
        primary: true,
        listEndpoint: "/records",
        createEndpoint: "/records",
        updateEndpoint: "/records/{id}",
        deleteEndpoint: "/records/{id}",
        displayName: "Record",
        displayNamePlural: "Records",
        icon: "album",
        profile: "owned-thing" /* physical · unique · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
          // Where the record lives (core-locations ref) — declared so it can
          // be exposed below, mirroring assets:asset.
          { name: "location_id", type: "text" },
          // Free-form custom-field blob (bundle / user fields) — the whole
          // point of this module. Declared so it can be exposed below.
          { name: "metadata", type: "object" },
        ],
        // Public face. `metadata` (the custom-field blob) is exposed — mirrors
        // assets:asset / inventory:part — so bundle/user custom fields can
        // drive saved views, search, and the calendar.
        exposableFields: ["name", "image_path", "metadata", "location_id"],
        detailRoute: "/records/{id}",
      },
    ],
  },

  intents: [{ name: "add_record", description: "Add a record to a collection" }],

  dependencies: [],

  exposes: {
    events: [
      "records.record.added",
      // Emitted on every PATCH with flat before/after field bags, so a
      // transition wire can compare {{event.before.x}} vs {{event.after.x}}.
      "records.record.updated",
      "records.record.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
