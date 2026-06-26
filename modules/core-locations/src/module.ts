// core-locations — workspace-wide tree of physical places.
//
// Every module with location-bearing entities (inventory:part,
// machines:machine, assets:asset, future kinds) carries a polymorphic
// location_id UUID referencing rows in this module's
// core_locations_locations table.
//
// Why foundational: locations are universal infrastructure (like
// tags, files, notifications) — turning them off would silently
// orphan location_id columns on every other entity. The platform
// guards against disabling foundational modules server-side.
//
// Previously these lived inside the inventory module as
// inventory:location, but conceptually they're cross-module — every
// physical thing wants one. The boot-time migration
// (api/src/platform/migrate-inventory-locations.ts) copies rows
// here preserving UUIDs so existing location_id references across
// machines / assets / inventory stay valid without rewrites.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-locations",
  version: "0.1.0",
  displayName: "Locations",
  description:
    "Workspace-wide hierarchical tree of physical places (rooms, shelves, bins). Every module's location-bearing entities reference rows here via polymorphic location_id.",
  icon: "map-pin",
  band: "foundational",

  schema: {
    tablePrefix: "core_locations_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "core-locations:location",
        displayName: "Location",
        displayNamePlural: "Locations",
        icon: "map-pin",
        fields: [
          { name: "name", type: "text", role: "title" },
          { name: "short_name", type: "text", role: "subtitle" },
          { name: "kind", type: "text" },
          { name: "parent_id", type: "text" },
          { name: "depth", type: "number" },
          // Manual sibling order set by drag (the `position` column). Declared
          // so it can be exposed (exposableFields must reference declared
          // fields) — the Labels browser reads it to match the page's order.
          { name: "position", type: "number" },
          { name: "description", type: "text", role: "summary" },
          { name: "notes", type: "text" },
          { name: "image_path", type: "image-path", role: "image" },
        ],
        getEndpoint: "/locations/{id}",
        // Direct detail route — promoted from "list-with-tree-nav"
        // to "open a location to see its contents + photo + notes".
        detailRoute: "/configuration/locations/{id}",
        // Locations themselves are physical (a shelf, a bin, a room)
        // and they CONTAIN physical things. Lets labels:print apply
        // to locations too — "label the bin."
        profile: "place",
        exposableFields: [
          "name",
          "short_name",
          "kind",
          "parent_id",
          "depth",
          // `position` (the manual drag order) is exposed so foreign consumers
          // — the Labels browser — can sort siblings by the SAME (position, then
          // natural name) order as the Locations page, via the shared
          // buildLocationForest. Without it they'd fall back to lexical name.
          "position",
          "description",
          "image_path",
        ],
      },
    ],
  },

  exposes: {
    events: [
      "core-locations.location.created",
      "core-locations.location.updated",
      "core-locations.location.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
