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
  version: "0.10.0",
  displayName: "Locations",
  description:
    "Where your things live: rooms, shelves and bins, one inside another, and a floor plan to draw them on.",
  icon: "map-pin",
  band: "foundational",

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Locations",
    route: "/locations",
    icon: "map-pin",
    overrideKey: "entity_kind:core-locations:location",
    // A place you go: rooms, bins, what is where. One of the two rows every
    // workspace has beside its collections.
    primary: true,
  },

  schema: {
    tablePrefix: "core_locations_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),
  lifecycle: {
    onBoot: async () => { (await import("./lights.js")).registerLights(); },
  },
  contributes: {
    wires: ["shown", "found", "picked", "put-away", "label-scanned"].map(reason => ({
      source_kind: "core-locations:location", action_id: "core-locations:indicate", trigger_type: "event" as const, trigger_event: `core-locations.light.${reason}`,
    })),
  },

  provides: {
    entityKinds: [
      {
        id: "core-locations:location",
        createEndpoint: "/locations",
        updateEndpoint: "/locations/{id}",
        deleteEndpoint: "/locations/{id}",
        displayName: "Location",
        displayNamePlural: "Locations",
        // Two "Shelf 1"s in the same rack are one shelf entered twice; the same
        // two in different racks are two shelves.
        duplicateScope: "parent_id",
        icon: "map-pin",
        fields: [
          { name: "name", type: "text", role: "title" },
          { name: "short_name", type: "text", role: "subtitle" },
          { name: "kind", type: "text", choices: ["container", "area"] },
          { name: "parent_id", type: "text" },
          { name: "depth", type: "number", readOnly: true },
          // Manual sibling order set by drag (the `position` column). Declared
          // so it can be exposed (exposableFields must reference declared
          // fields) — the Labels browser reads it to match the page's order.
          { name: "position", type: "number", readOnly: true },
          { name: "description", type: "text", role: "summary" },
          { name: "notes", type: "text" },
          { name: "image_path", type: "image-path", role: "image" },
          // A container's declared interior size in millimeters, {x,y,z}
          // (metadata.interior_mm) — DECLARED capacity, what size-aware
          // consumers (Guided Organize) read. Never inferred.
          { name: "interior_mm", type: "object" },
        ],
        getEndpoint: "/locations/{id}",
        // Direct detail route — promoted from "list-with-tree-nav"
        // to "open a location to see its contents + photo + notes".
        detailRoute: "/locations/{id}",
        // Locations themselves are physical (a shelf, a bin, a room)
        // and they CONTAIN physical things. Lets labels:print apply
        // to locations too — "label the bin."
        profile: "place",
        // A location is name-unique (there is one "Office"), so a
        // disambiguating code drawn in the QR center is noise. Declare the
        // labeling default OFF for this kind; parts/machines (many similar
        // items) keep it on. The labels module reads this generically off the
        // registry — this is a DECLARATION, not a labels-side special case.
        // A user's explicit per-kind toggle still overrides it.
        labelCodeOverlayDefault: false,
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
          // Declared interior size — read by size-aware consumers (the
          // organize planner's fit checks).
          "interior_mm",
        ],
      },
    ],
  },

  // A place with places inside it takes all of them when it goes, and what was
  // kept in them loses its place. Deleting one shelf stays open to a member;
  // clearing out a whole room is an owner's or admin's call, or a grant of
  // this (DELETE /locations/:id asks for it only when the place has places
  // inside it).
  capabilities: [
    {
      id: "core-locations:delete-with-places-inside",
      label: "Delete a place with places inside it",
      description: "Delete a room, rack or shelf together with every place inside it. Deleting a place with nothing inside it does not need this.",
    },
  ],

  exposes: {
    events: [
      "core-locations.location.created",
      "core-locations.location.updated",
      "core-locations.location.deleted",
      "core-locations.light.shown",
      "core-locations.light.found",
      "core-locations.light.picked",
      "core-locations.light.put-away",
      "core-locations.light.label-scanned",
    ],
    // Sentences people say to a locations module on day one, before they have
    // connected any AI at all. Numbering a run of shelves or bins is the single
    // most common bulk ask there is, and the one an AI was previously required
    // for. `from`/`to` are the range pair; `n` is the counter inside a name.
    commands: [
      {
        id: "core-locations:number-a-run",
        template: "make {label} {from} through {to} in {parent}",
        description: "Create a numbered run of places inside another one.",
        plan: [
          {
            tool: "create" as const,
            entityKind: "core-locations:location",
            payload: { name: "{label} {n}", kind: "container", parent: "{parent}" },
          },
        ],
        repeatField: "name",
        repeatShape: "{label} {n}",
      },
      {
        id: "core-locations:add-place",
        template: "add a place called {name} in {parent}",
        description: "Create one place inside another.",
        plan: [
          {
            tool: "create" as const,
            entityKind: "core-locations:location",
            payload: { name: "{name}", kind: "container", parent: "{parent}" },
          },
        ],
      },
    ],
    actions: [
      {
        group: "stock",
        id: "core-locations:show-me", label: "Where is it?", icon: "lightbulb", effect: "signal",
        description: "Find this thing's place, including inside containers, and light its bin or nearest lit ancestor. Use this when asked where something is. The light turns off automatically.",
        examples: ["where are my M3 screws?", "show me this bin", "light up the shelf"],
        appliesTo: { traits: ["physical"] }, invokeHandler: "core-locations.show-me",
      },
      {
        group: "stock",
        id: "core-locations:indicate", label: "Light up this place", icon: "lightbulb", effect: "signal",
        description: "Run place.indicate on this place's mapped connection. Signals need no confirmation and are rate limited. Default color is the workspace accent; another request uses a second color.",
        appliesTo: { kinds: ["core-locations:location"] }, invokeHandler: "core-locations.indicate", userInvokable: false,
        argsSchema: { color: { label: "Color (RRGGBB)", type: "text" }, duration: { label: "Seconds (1 to 300)", type: "number" } },
      },
      {
        group: "stock",
        id: "core-locations:set-light", label: "Set this place's light", description: "Set mapping: {connection_id, driver: wled, pixels: [{segment, led, count}]} or {connection_id, driver: home-assistant, entity: light.name}. Null removes it. Share the connection with this workspace first.",
        appliesTo: { kinds: ["core-locations:location"] }, invokeHandler: "core-locations.set-light", userInvokable: false,
        argsSchema: { mapping: { label: "Light mapping", type: "json" } },
      },
      {
        group: "stock",
        id: "core-locations:map-light-grid", label: "Map this grid's lights", description: "Map every child bin from its floor plan position. grid: {connection_id, mode: strip|xy, segment, start, per_bin, order: row-major|serpentine, column_segment?, column_start?}. All bins must form a complete grid.",
        appliesTo: { kinds: ["core-locations:location"] }, invokeHandler: "core-locations.map-light-grid", userInvokable: false,
        argsSchema: { grid: { label: "Grid light settings", type: "json", required: true } },
      },
      {
        // Workspace-scoped: it orders a SET of siblings, not one record, so
        // there is no single entity for it to hang off.
        group: "stock",
        id: "core-locations:reorder",
        examples: ["put the racks in order", "sort the shelves under Den"],
        undoable: true,
        label: "Reorder locations",
        description:
          "Set the order sibling locations appear in under the same parent. Pass `ids`: the location ids of ONE parent's children, in the order you want them (use list_records on core-locations:location to read them). This is the only way the order changes: `position` is maintained here, and an update that sets it is refused. The tree lists shallowest first, then this order, then alphabetically.",
        icon: "arrow-up-down",
        scope: "workspace" as const,
        invokeHandler: "core-locations.reorder",
        argsSchema: {
          ids: { label: "Location ids, in the order they should appear", type: "list" as const, required: true },
        },
      },
      {
        // The person-facing door is "Move everything to…" on the place's own
        // page (a picker for the destination); this is the assistant's.
        group: "stock",
        id: "core-locations:move-everything",
        examples: ["move everything from Bin 3 to Bin 7", "empty the old shelf into the new one", "merge the two Bin 3s"],
        label: "Move everything to another place",
        description:
          "Move every thing kept in this place into another place, through placement, each move recorded on the thing. `to`: the destination place's id, or with `to_kind` a thing that holds things (a Backpack, a toolbox; the things go inside it, places cannot). `places: true` also moves the places inside it (with their contents) under the destination. `then_delete: true` merges: moves everything including the places, then deletes this now-empty place. Refused when the destination is inside this place and places would move. Undo puts each thing and place back, and restores a merged-away place.",
        appliesTo: { kinds: ["core-locations:location"] },
        invokeHandler: "core-locations.move-everything",
        userInvokable: false,
        argsSchema: {
          to: { label: "Destination place id", type: "text" as const, required: true },
          to_kind: { label: "Destination kind, when it is a thing that holds things (a Backpack) rather than a place", type: "text" as const },
          places: { label: "Also move the places inside it", type: "boolean" as const },
          then_delete: { label: "Then delete this place (merge)", type: "boolean" as const },
        },
      },
      {
        // The person-facing door is the swatch row in Edit layout on the
        // floor plan; this is the assistant's.
        group: "stock",
        id: "core-locations:set-plan-colour",
        examples: ["make the red chest's drawers red", "colour Shelf 3 blue on the plan", "take the colour off Bin 4"],
        undoable: true,
        label: "Set its colour on the plan",
        description:
          "Give a place a colour on its floor plan, so places that belong together read together (every drawer of one tool chest, say). `colour`: one of red, orange, yellow, green, blue, purple, grey, or none to take it off. The plan outlines the place in that colour and lists it as Custom in the legend. This selects the manual colour instead of an attached tag. Undo restores the previous outline group. Set it on each place in turn.",
        icon: "palette",
        appliesTo: { kinds: ["core-locations:location"] },
        invokeHandler: "core-locations.set-plan-colour",
        userInvokable: false,
        argsSchema: {
          colour: { label: "Colour: red, orange, yellow, green, blue, purple, grey, or none", type: "text" as const, required: true },
          outline_group: { label: "Previous outline group (for Undo)", type: "text" as const },
        },
      },
      // A whole house as one file (floorplan-file.ts). The person-facing
      // doors are Import a plan and Export on the floor plan.
      {
        group: "stock",
        // UI-SCREEN: /locations
        id: "core-locations:import-floorplan",
        examples: ["import this floor plan", "bring in the plan another AI made of my house"],
        undoable: true,
        label: "Import a floor plan",
        description:
          "Make or update rooms, levels, zones, racks, shelves and drawers from a cobblr-floorplan/1 plan (JSON, as text or an object; https://docs.cobblr.xyz/schemas/cobblr-floorplan-1.json). Matched by name under each parent, so the same plan twice makes nothing new; nothing missing from the plan is deleted; anything outside its room is moved inside and warned about. `dry_run: true` says what it would make and update and writes nothing: run that first and show it. Undo takes the import back.",
        icon: "upload",
        scope: "workspace" as const,
        invokeHandler: "core-locations.import-floorplan",
        userInvokable: false,
        argsSchema: {
          plan: { label: "The plan (cobblr-floorplan/1 JSON)", type: "json" as const, required: true },
          dry_run: { label: "Only say what it would do", type: "boolean" as const },
        },
      },
      {
        group: "stock",
        id: "core-locations:export-floorplan",
        examples: ["export my house plan", "give me the floor plan as JSON"],
        label: "Export a floor plan",
        description:
          "This place and every room drawn under it as one cobblr-floorplan/1 plan: sizes, walls and openings, zones, containers with their shelves and drawers. Importing it back changes nothing. Changes nothing.",
        icon: "download",
        appliesTo: { kinds: ["core-locations:location"] },
        invokeHandler: "core-locations.export-floorplan",
        userInvokable: false,
        argsSchema: {},
      },
      // NO-PHRASING: only ever run as Import a floor plan's Undo, never asked for.
      {
        group: "stock",
        id: "core-locations:undo-floorplan-import",
        label: "Undo a floor plan import",
        description: "The way back for Import a floor plan: puts each place it updated back as it was and deletes the ones it made.",
        scope: "workspace" as const,
        internal: true,
        userInvokable: false,
        invokeHandler: "core-locations.undo-floorplan-import",
        argsSchema: { import: { label: "The import to undo", type: "json" as const, required: true } },
      },
      // NO-PHRASING: only ever run as Move everything's Undo, never asked for.
      {
        group: "stock",
        id: "core-locations:put-back-everything",
        label: "Put back what was moved",
        description: "The way back for Move everything: puts each thing and place back where the move found it.",
        scope: "workspace" as const,
        internal: true,
        userInvokable: false,
        invokeHandler: "core-locations.put-back-everything",
        argsSchema: {
          move: { label: "The move to put back", type: "json" as const, required: true },
        },
      },
    ],
  },

  subscribes: [],
});
