// Records — the neutral generic-record substrate. A record carries ONLY
// the universal base (name, image, notes, location, custom-field bag):
// catalog-like collections (a Bookshelf, a Movies list) become instances
// of this module and declare their own fields, instead of riding on
// assets and inheriting a drill-press's columns.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "records",
  version: "0.1.5",
  displayName: "Records",
  description:
    "A blank collection that you give its own fields: a bookshelf, a movie list, a recipe box.",
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
          // Where it is, by name: its place, or what it is inside ("Backpack,
          // in Desk drawer"). Derived on read, so a search or the assistant can
          // say where it is.
          { name: "location_name", type: "text", readOnly: true },
          // Free-form custom-field blob (bundle / user fields) — the whole
          // point of this module. Declared so it can be exposed below.
          { name: "metadata", type: "object" },
        ],
        // Public face. `metadata` (the custom-field blob) is exposed — mirrors
        // assets:asset / inventory:part — so bundle/user custom fields can
        // drive saved views, search, and the calendar.
        exposableFields: ["name", "image_path", "metadata", "location_id", "location_name"],
        detailRoute: "/records/{id}",
      },
    ],
  },

  dependencies: [],

  exposes: {
    events: [
      "records.record.added",
      // Emitted on every PATCH with flat before/after field bags, so a
      // transition wire can compare {{event.before.x}} vs {{event.after.x}}.
      "records.record.updated",
      "records.record.deleted",
    ],
    actions: [],
  },

  subscribes: [],
});
