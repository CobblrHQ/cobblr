// Inventory — the first Cobblr connector.
//
// Parts + Categories + Allocations, all scoped to a tenant DB.
// Locations used to live here too but graduated to core-locations
// (foundational) once it became clear every module with physical
// entities wants to reference the same tree. Existing
// inventory_locations rows are mirrored into core_locations_locations
// at boot (see api/src/platform/migrate-inventory-locations.ts).
// The platform sees this module via its manifest; runtime API + UI
// are imported lazily by the loader when needed.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "inventory",
  version: "0.1.0",
  displayName: "Inventory",
  description:
    "Parts, locations, categories, stock tracking, polymorphic allocations. The generalised toolkit you'd otherwise Frankenstein from a spreadsheet.",
  icon: "boxes",
  band: "stock",
  instanceability: "multi",

  schema: {
    tablePrefix: "inventory_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // ──────────────── Pillar A — entity kinds we provide ─────────────
  provides: {
    entityKinds: [
      {
        id: "inventory:part",
        displayName: "Part",
        displayNamePlural: "Parts",
        icon: "boxes",
        profile: "stock-material" /* physical · fungible · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "qty", type: "number", role: "quantity" },
          { name: "unit", type: "text", role: "unit" },
          { name: "cost", type: "number" },
          { name: "min_qty", type: "number" },
          { name: "manufacturer", type: "text" },
          { name: "supplier_url", type: "url" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
        ],
        // Cross-module readable: name + description for labels & rendering,
        // qty/min_qty for low-stock / dep-satisfied checks, unit for quantity
        // display, image for galleries. Internal-only: cost (commercial),
        // manufacturer/supplier_url (procurement detail), notes (free-text).
        exposableFields: [
          "name",
          "description",
          "qty",
          "unit",
          "min_qty",
          "image_path",
        ],
        detailRoute: "/inventory/parts/{id}",
      },
    ],
  },

  intents: [
    { name: "add_part", description: "Add a new part to inventory" },
    { name: "adjust_stock", description: "Increase or decrease a part's on-hand quantity" },
    { name: "allocate_part", description: "Reserve a part for an entity in another module" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "inventory.part.created",
      "inventory.part.updated",
      "inventory.part.deleted",
      "inventory.stock.changed",
      "inventory.stock.low",
      "inventory.allocation.reserved",
      "inventory.allocation.consumed",
      "inventory.allocation.released",
    ],
    api: ["getPartById", "searchParts", "adjustStock", "allocate", "release"],
    actions: [
      {
        id: "inventory:adjust-stock",
        label: "Adjust part stock",
        description:
          "Add or subtract from a part's on-hand qty. Wire it to purchases.order_item.received for auto-bump-on-arrival, or fire it from any other event source. Args: { partId, delta, reason? }.",
        appliesTo: { any: true },
        invokeHandler: "inventory.adjust-stock",
        // Wire-driven only — clicking it on an arbitrary entity
        // doesn't make sense; the user has stock-adjust HTTP for
        // direct edits.
        userInvokable: false,
      },
    ],
  },

  subscribes: [],

  // The "order arrival auto-bumps part stock" flow is a wire, not
  // hardcoded code. Ship it as a default; users can edit / disable
  // / replace it. The wire belongs to inventory because inventory
  // owns the action it fires.
  contributes: {
    wires: [
      {
        source_kind: "purchases:order_item",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "purchases.order_item.received",
      },
    ],
  },
});
