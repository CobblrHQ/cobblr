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
        // Drives the wire composer's structured "With" form. Values can be
        // literals or {{tokens}} (e.g. delta = {{event.delta}}), rendered at
        // fire time against the event payload + target entity.
        argsSchema: {
          partId: { label: "Part id", type: "text" },
          delta: { label: "Change in qty (+ adds, − subtracts)", type: "number" },
          reason: { label: "Reason (optional)", type: "text" },
        },
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
      {
        id: "inventory:create-item",
        label: "Add an item",
        description:
          "Create an inventory item in an instance — name + custom fields (metadata) + an optional location / brand / qty. The canonical CREATE a custom (Tier B) app block performs (there was no invokable create before — only set-status / adjust-stock). Generic: the caller composes the name + fields and decides what to make. User-invokable so a granted worker can run it. Args: { instance, name, fields?, location_id?, manufacturer?, qty?, unit? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.create-item",
        userInvokable: true,
        argsSchema: {
          instance: { label: "Instance (table) name", type: "text" },
          name: { label: "Item name", type: "text" },
        },
      },
      {
        id: "inventory:create-items",
        label: "Add items (bulk)",
        description:
          "Bulk-create N inventory items in one INSERT (a kit BOM, a CSV import, a batch from another module). Returns the new ids in input order so the caller can wire pairings. Does NOT fan out per-item created events. Generic. Args: { items: [{ name, instance?, fields?, qty?, unit?, image_path?, manufacturer?, location_id? }] }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.create-items",
        userInvokable: true,
      },
      {
        id: "inventory:update-item",
        label: "Update an item",
        description:
          "Set a part's name / brand / location and/or MERGE metadata fields (e.g. mark a kit's metadata.lifecycle='parted-out'). The companion to create-item — lets a Tier-B app or another module edit an item through inventory's public interface. Generic. Args: { id, name?, manufacturer?, location_id?, fields? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.update-item",
        userInvokable: true,
      },
      {
        id: "inventory:lift-to-type",
        label: "Lift items into types",
        description:
          "Bundle-migration engine: lift each item in a SOURCE instance into a TYPE in another instance — deduped by key fields, copying the type-defining fields up, linked via a pairing, optionally converting the qty unit. How a flat single-instance bundle upgrades into a type→instances model on a version bump. Idempotent (skips already-linked items). Generic — the bundle's migration declares the params. Args: { source_instance, type_instance, key_fields[], copy_fields?[], relationship_kind?, convert_qty?: { from_unit, to_unit, factor } }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.lift-to-type",
        // Migration-only: run by the bundle-upgrade flow, never a detail button.
        userInvokable: false,
      },
      {
        id: "inventory:split-lot",
        label: "Split one off",
        description:
          "Split units off a lot's quantity into a NEW separate item (default 1 — the 'I entered 5 spools as one lot and just opened one' move). The new item inherits the lot's instance, fields, manufacturer, location, image, and parent pairing(s) so type rollups still count it; the lot's qty drops by the split amount. Generic — works on any inventory item with a numeric qty, in any instance. The lot must keep ≥1. Args: { quantity?: number (default 1) }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.split-lot",
        userInvokable: true,
        argsSchema: {
          quantity: { label: "How many to split off", type: "number" },
        },
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
