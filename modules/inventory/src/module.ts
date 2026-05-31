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
          // Free-form JSON attribute blob. Declared so we can also
          // include it in exposableFields below — cross-module readers
          // (bricklink-connector reading metadata.lego.color_id, etc.)
          // go through platform.entities.lookupMany. The schema is
          // intentionally `object` not a fixed shape; each consumer
          // module stuffs its own namespace under a top-level key.
          { name: "metadata", type: "object" },
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
          // `metadata` is the per-part free-form attribute blob —
          // already conceptually a cross-module surface (modules
          // stuff their own keys here, e.g. metadata.lego.color_id
          // for the bricklink connector to match against). Exposing
          // it lets foreign modules read those keys via
          // platform.entities.lookupMany instead of reaching into
          // inventory_parts directly.
          "metadata",
          // `cost` IS exposable but capability-gated below — it flows
          // to member-facing reads only for viewers who hold
          // inventory:view-costs. supplier_url / manufacturer / notes
          // stay fully internal (absent here on purpose).
          "cost",
        ],
        // H2 — per-field read-scope: `cost` is the commercial figure.
        // Exposable (above) so it CAN reach the portal/views, but gated
        // so only viewers granted `inventory:view-costs` actually see
        // it. This is a beta tester's "Tier 1 sees parts, Tier 2 also sees
        // prices": admins/owners see everything; a member sees cost
        // only once granted the capability (via a role or direct grant).
        fieldReadScopes: {
          cost: "inventory:view-costs",
        },
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
        // Tightened from { any: true } to inventory:part-only — wire
        // can still hit it for any source via target traversal, but
        // the manual-button surface stays scoped.
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.adjust-stock",
        // Wire-driven only — clicking it on an arbitrary entity
        // doesn't make sense; the user has stock-adjust HTTP for
        // direct edits.
        userInvokable: false,
      },
      {
        id: "inventory:disassemble-kit",
        label: "Disassemble into parts",
        description:
          "Expand a kit (an inventory:part matched to a Rebrickable set) into its constituent parts. Reads the rebrickable-inventory-parts BOM catalog, spawns one inventory:part per BOM row, writes a `matches` pairing to each Rebrickable part entry + a `derived-from` pairing back to the kit, and flips the kit's metadata.state to 'parted-out'. Requires the BOM catalog to be loaded (node scripts/seed-rebrickable.mjs --include-bom).",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.disassemble-kit",
      },
      {
        id: "inventory:set-status",
        label: "Set status",
        description:
          "Set a part's `metadata.status` (e.g. a Lego set's Built / Unbuilt / Missing pieces). A member-appropriate, user-invokable action: grant it and a worker can update status from their app — the canonical write a custom (Tier B) app block performs. Args: { partId?, status }; partId falls back to the targeted entity.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.set-status",
        userInvokable: true,
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
