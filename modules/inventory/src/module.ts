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
  version: "0.21.24",
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
        // Two "M3 bolt" rows in the SAME bin are one part counted twice;
        // the same name in two bins is two piles of bolts, which is how
        // people actually store them.
        duplicateScope: "location_id",
        primary: true,
        listEndpoint: "/parts",
        createEndpoint: "/parts",
        updateEndpoint: "/parts/{id}",
        deleteEndpoint: "/parts/{id}",
        displayName: "Part",
        displayNamePlural: "Parts",
        icon: "boxes",
        profile: "stock-material" /* physical · fungible · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "qty", type: "number", role: "quantity", trait: "fungible" },
          { name: "unit", type: "text", role: "unit", trait: "fungible" },
          { name: "cost", type: "number", trait: "fungible" },
          { name: "min_qty", type: "number", trait: "fungible" },
          // An ESTIMATE, deliberately not role:"quantity" — that role means a
          // counted amount, and a face reading it as one would render a guess
          // with a stepper. Its presence is what marks a record as an
          // assortment. See docs/design-decisions/assorted-contents.md.
          { name: "approximate_qty", type: "number", trait: "fungible" },
          { name: "estimated_at", type: "date", trait: "fungible" },
          { name: "manufacturer", type: "text", trait: "fungible" },
          { name: "supplier_url", type: "url", trait: "fungible" },
          { name: "image_path", type: "image-path", role: "image" },
          { name: "notes", type: "text" },
          // The category it is filed under, by name (resolved from category_id).
          { name: "category_name", type: "text" },
          // Where it lives, by name (resolved from location_id through the platform).
          { name: "location_name", type: "text" },
          // Free-form JSON attribute blob. Declared so we can also
          // include it in exposableFields below — cross-module readers
          // (bricklink-connector reading metadata.lego.color_id, etc.)
          // go through platform.entities.lookupMany. The schema is
          // intentionally `object` not a fixed shape; each consumer
          // module stuffs its own namespace under a top-level key.
          { name: "metadata", type: "object" },
          // Where it lives — the scan "already tracked" banner shows it and
          // move-mode uses it to skip entities already in the active bin.
          { name: "location_id", type: "text" },
          // serial_number is a real column (HomeBox parity, migration 0004) but
          // has lived outside this manifest list, which is a curated subset the
          // platform reasons over (the UI renders from the row, not from here).
          // Declared now with fieldRole "identifier" so the resolvable registry
          // builds a scan+search provider for it: a lasered serial resolves to its
          // part with no hand-written QR rule. The sibling parity fields
          // (model_number, assigned_to, warranty_*) stay undeclared — they are not
          // identifiers. See docs/design-decisions/resolvable-registry.md D6.
          { name: "serial_number", type: "text", fieldRole: "identifier", trait: "unique" },
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
          // A grouping, not a secret: what a thing is filed under is how
          // another module (or the assistant) tells rice from screws.
          "category_name",
          // Where it lives, by name: the answer to "where is my lamp".
          "location_name",
          // `metadata` is the per-part free-form attribute blob —
          // already conceptually a cross-module surface (modules
          // stuff their own keys here, e.g. metadata.lego.color_id
          // for the bricklink connector to match against). Exposing
          // it lets foreign modules read those keys via
          // platform.entities.lookupMany instead of reaching into
          // inventory_parts directly.
          "metadata",
          "location_id",
          // The estimate is safe to expose and has to be: a container rolling
          // up "10 kinds, roughly 50" is a cross-module read (core-placement
          // renders it), and without this the projection strips it and the
          // rollup silently reads zero.
          "approximate_qty",
          "estimated_at",
          // `cost` IS exposable but capability-gated below — it flows
          // to member-facing reads only for viewers who hold
          // inventory:view-costs. supplier_url / manufacturer / notes
          // stay fully internal (absent here on purpose).
          "cost",
        ],
        // H2 — per-field read-scope: `cost` is the commercial figure.
        // Exposable (above) so it CAN reach the portal/views, but gated
        // so only viewers granted `inventory:view-costs` actually see
        // it. This is the club scenario's "Tier 1 sees parts, Tier 2 also sees
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
      // What a one-tap mark MEANT, in a consumption ledger's vocabulary
      // (purchase / consume / discard). Same shape as core-scan.stock.observed.
      "inventory.stock.observed",
      "inventory.stock.low",
      // The replace-clock came due (metadata.replace_every_days elapsed) — a
      // bundle wires this to the shopping list / a notification. Fired by the
      // core-recurrence scanner (see api/replace-clock.ts).
      "inventory.part.replace-due",
      // Burn-rate predicts this part runs out within the lead window — fire
      // AHEAD of empty so the shopping-list wire reorders in time. Fired by the
      // hourly burn-rate sweeper (see burn-rate.ts).
      "inventory.stock.predicted-low",
      "inventory.allocation.reserved",
      "inventory.allocation.consumed",
      "inventory.allocation.released",
      "inventory.category.created", // emitted by categories.ts — declare so it's bindable (audit 2026-06-26)
    ],
    api: ["getPartById", "searchParts", "adjustStock", "allocate", "release"],
    actions: [
      // DECLARED IN THE ORDER A PERSON WANTS THEM. The record's strip shows the
      // first few in the open and folds the rest. One button per gesture: the
      // perishable/durable difference is decided inside the handler from the
      // record ("Used up" ends a lot or empties a bin; "Replaced" swaps a
      // fresh lot in or stamps a spare), never by a second button. The
      // wire-only aliases that used to be buttons sit after the visible set.
      {
        id: "inventory:use-one",
        examples: ["used one", "I just took one out"],
        undoable: true,
        label: "Use one",
        face: "stock",
        description:
          "Knock a single unit off a part's on-hand qty: the zero-friction 'I took one out' tap. Binary, no number entry (that's Adjust stock). Decrements through the same path as adjust-stock, so it writes the usage ledger and trips 'running low → shopping list' when it crosses the reorder threshold. partId falls back to the targeted entity.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.use-one",
        userInvokable: true,
      },
      {
        id: "inventory:mark-opened",
        examples: ["opened it", "cracked open the pesto", "started this one"],
        undoable: true,
        label: "Opened",
        face: "perishable",
        description:
          "Record that you opened one, today. Starts the shorter opened clock on that one only - the unopened ones keep their own dates - and records WHEN, so how long it lasts after opening can be measured the next time one goes off. Args: { partId?, timezone? }.",
        // Only where something CAN go off: a table whose bundle marked a field as
        // the expiry role ("Best before", "Use by"). Scoped to the whole kind,
        // this offered "Threw it out" on a box of screws (audit, 2026-09-08).
        appliesTo: { hasFieldRole: "expiry" },
        invokeHandler: "inventory.mark-opened",
        userInvokable: true,
        argsSchema: {
          partId: { label: "Which item", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
        },
      },
      {
        id: "inventory:use-up",
        examples: ["used it up", "that is all gone", "ate the last one"],
        undoable: true,
        label: "Used up",
        face: "stock",
        description:
          "One verb for the end of a thing, whatever kind of thing it is. On something that goes off (a table with an expiry field, lots dated on arrival) it ends the OLDEST lot as used, records how long it lasted as a lower bound on its shelf life, and takes one off the count - the same bookkeeping mark-finished does. On plain stock it empties the count. Args: { partId?, timezone? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.use-up",
        argsSchema: {
          partId: { label: "Which item, defaults to the record this ran on", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
        },
        userInvokable: true,
      },
      {
        id: "inventory:mark-spoiled",
        examples: ["it went bad", "had to bin it", "this one spoiled before I got to it"],
        undoable: true,
        label: "Threw it out",
        face: "perishable",
        description:
          "Record that one went bad and was binned. This is the only thing that MEASURES how long something keeps, so it is what teaches the shelf life; it also files a waste event, which is what tells you when you are consistently buying more than you get through. Args: { partId?, timezone? }.",
        // Only where something CAN go off: a table whose bundle marked a field as
        // the expiry role ("Best before", "Use by"). Scoped to the whole kind,
        // this offered "Threw it out" on a box of screws (audit, 2026-09-08).
        appliesTo: { hasFieldRole: "expiry" },
        invokeHandler: "inventory.mark-spoiled",
        userInvokable: true,
        argsSchema: {
          partId: { label: "Which item", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
        },
      },
      {
        id: "inventory:restock-one",
        examples: ["another one arrived", "got one more", "add one to the fridge"],
        undoable: true,
        label: "Restock one",
        face: "perishable",
        description:
          "Record that another one arrived today. NOT the same as adding one to the count: a container arriving today has its own shelf life, so this dates the new arrival from the item's shelf_life_days rather than letting it inherit the previous one's deadline. Several on the same day merge into one lot. Args: { partId?, qty?, timezone? }.",
        // Only where something CAN go off: a table whose bundle marked a field as
        // the expiry role ("Best before", "Use by"). Scoped to the whole kind,
        // this offered "Threw it out" on a box of screws (audit, 2026-09-08).
        appliesTo: { hasFieldRole: "expiry" },
        invokeHandler: "inventory.restock-one",
        userInvokable: true,
        argsSchema: {
          partId: { label: "Which item", type: "text" },
          qty: { label: "How many arrived", type: "number" },
          timezone: { label: "Timezone to date the arrival in", type: "text" },
        },
      },
      {
        id: "inventory:replaced",
        examples: ["replaced the filter", "swapped in a new box", "replaced it with a fresh one"],
        undoable: true,
        label: "Replaced",
        face: "stock",
        description:
          "One verb for swapping a thing out. On something that goes off it consumes the oldest lot and adds a fresh one dated today from the item's shelf life - the same bookkeeping swap-fresh does. On plain stock it stamps when it was replaced and consumes a spare if there is one. Args: { partId?, timezone? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.replaced",
        argsSchema: {
          partId: { label: "Which item, defaults to the record this ran on", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
        },
        userInvokable: true,
      },
      {
        id: "inventory:set-status",
        examples: ["mark it as built", "set that to missing pieces"],
        undoable: true,
        label: "Set status",
        description:
          "Set a part's `metadata.status` (e.g. a Lego set's Built / Unbuilt / Missing pieces). A member-appropriate, user-invokable action: grant it and a worker can update status from their app: the canonical write a custom (Tier B) app block performs. Args: { partId?, status }; partId falls back to the targeted entity.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.set-status",
        argsSchema: {
          partId: { label: "Which part, defaults to the record this ran on", type: "text" },
          status: { label: "The status to set", type: "text" },
        },
        userInvokable: true,
      },
      {
        id: "inventory:reserve-stock",
        examples: ["set aside four for that project", "reserve some of these"],
        undoable: true,
        label: "Reserve stock for something",
        face: "lendable",
        description:
          "Set aside some of this part for a project, build or order, without moving stock yet. Pass `qty`, and `for_kind` + `for_id` saying what it is reserved for (list_records gives you the id). Optionally `reason`, which becomes the line on the part's statement when it is consumed. Stock only moves when the reservation is CONSUMED (inventory:settle-allocation).",
        icon: "bookmark",
        // Lending is a trait a collection wears (custody, a trial axis); this verb
        // sat on every inventory part, tea included, until it said so.
        appliesTo: { traits: ["fungible", "lendable"] },
        invokeHandler: "inventory.reserve-stock",
        argsSchema: {
          qty: { label: "How much to reserve", type: "number" },
          for_kind: { label: "Kind it is reserved for (e.g. projects:project)", type: "text" },
          for_id: { label: "Id of that record", type: "text" },
          reason: { label: "What it is for (shown on the statement)", type: "text" },
        },
      },
      {
        id: "inventory:split-lot",
        examples: ["split one off that lot", "I opened one of the pack"],
        label: "Split one off",
        face: "stock",
        description:
          "Split units off a lot's quantity into a NEW separate item (default 1 (the 'I entered 5 spools as one lot and just opened one' move). The new item inherits the lot's instance, fields, manufacturer, location, image, and parent pairing(s) so type rollups still count it; the lot's qty drops by the split amount. Generic) works on any inventory item with a numeric qty, in any instance. The lot must keep ≥1. Args: { quantity?: number (default 1) }.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.split-lot",
        userInvokable: true,
        argsSchema: {
          quantity: { label: "How many to split off", type: "number" },
        },
      },
      {
        id: "inventory:mark-finished",
        examples: ["ate the last one", "that's the end of the jar", "all gone"],
        undoable: true,
        label: "Finished it",
        face: "perishable",
        description:
          "Record that you used the last of one up. Counts as a LOWER BOUND on how long it keeps - it lasted at least this long - and never as a measurement, because you ate it rather than testing it. Args: { partId?, timezone? }.",
        // Only where something CAN go off: a table whose bundle marked a field as
        // the expiry role ("Best before", "Use by"). Scoped to the whole kind,
        // this offered "Threw it out" on a box of screws (audit, 2026-09-08).
        appliesTo: { hasFieldRole: "expiry" },
        // Kept for wires and the assistant ("ate the last one"). The BUTTON is "Used up", which does this on a perishable and empties plain stock; two buttons for one gesture was the report (2026-09-08).
        userInvokable: false,
        invokeHandler: "inventory.mark-finished",
        argsSchema: {
          partId: { label: "Which item", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
        },
      },
      {
        id: "inventory:swap-fresh",
        examples: ["swapped in a new box", "finished it and opened the new one", "replaced it with a fresh one"],
        undoable: true,
        label: "Replaced with a fresh one",
        face: "perishable",
        description:
          "The old one is finished and an identical new one arrived, in one tap. The count does not move, the old lot ends as used (a floor on its shelf life), the new lot is dated today, and the consumption ledger hears one consumed and one bought, which is how it learns how often you go through it. Args: { partId?, timezone? }.",
        // Only where something CAN go off: a table whose bundle marked a field as
        // the expiry role ("Best before", "Use by"). Scoped to the whole kind,
        // this offered "Threw it out" on a box of screws (audit, 2026-09-08).
        appliesTo: { hasFieldRole: "expiry" },
        // Kept for wires and the assistant. The BUTTON is "Replaced", which does this on a perishable.
        userInvokable: false,
        invokeHandler: "inventory.swap-fresh",
        argsSchema: {
          partId: { label: "Which item", type: "text" },
          timezone: { label: "Timezone to date the new one in", type: "text" },
        },
      },
      {
        id: "inventory:adjust-stock",
        examples: ["add 5 to the M3 screws", "take 2 off that spool"],
        undoable: true,
        label: "Adjust part stock",
        description:
          "Add or subtract from a part's on-hand qty. Wire it to purchases.order_item.received for auto-bump-on-arrival, or fire it from any other event source. Args: { partId, delta, reason?, restock? }. With restock: true a positive delta is stock that arrived: a lot dated today, good until today plus the item's shelf life, and the record's bought-on date moves to today. Anything arriving on an empty record is dated the same way.",
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
          restock: { label: "This is stock that arrived: date it today (optional)", type: "boolean" },
          timezone: { label: "Timezone to date arriving stock in (optional)", type: "text" },
          reason: { label: "Reason (optional)", type: "text" },
          sourceKind: { label: "Record kind this adjustment came from (optional)", type: "text" },
          sourceId: { label: "Record id this adjustment came from (optional)", type: "text" },
        },
      },
      {
        id: "inventory:set-stock",
        examples: ["there are 40 left", "set the count to 12"],
        undoable: true,
        label: "Set part stock",
        description:
          "Set a part's on-hand qty to an ABSOLUTE value (not a delta). The natural op for a scale ('grams remaining'), a stocktake, or a recount. Reached from core-devices.device.reading via a device→part link, or any source. Args: { partId, qty, reason? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.set-stock",
        userInvokable: false,
        argsSchema: {
          partId: { label: "Part id", type: "text" },
          qty: { label: "On-hand qty (absolute)", type: "number" },
          reason: { label: "Reason (optional)", type: "text" },
        },
      },
      // The three below are the way back for other actions, run by Undo on a
      // card: never a button, never for an assistant to reach for. Declared so
      // the undo rail can run them through the same door as everything else.
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        id: "inventory:restore-part",
        internal: true,
        label: "Put a part back",
        description:
          "Internal, the inverse of a stock move, a lifecycle mark or an item edit: puts a part's count, name, place and changed fields back to what they were. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.restore-part",
        argsSchema: {
          partId: { label: "The part", type: "text" },
          qty: { label: "The count to put back", type: "number" },
          name: { label: "The name to put back", type: "text" },
          location_id: { label: "The place to put back", type: "text" },
          metadata: { label: "Fields to put back", type: "json" },
          absent: { label: "Fields to remove", type: "list" },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        id: "inventory:remove-category",
        internal: true,
        label: "Remove a category",
        description: "Internal, the inverse of adding a category: removes one nothing is filed under. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.remove-category",
        argsSchema: {
          category_id: { label: "The category's id", type: "text" },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        id: "inventory:reopen-allocation",
        internal: true,
        label: "Reopen a reservation",
        description: "Internal, the inverse of consuming or releasing a reservation: it is reserved again, and consumed stock comes back. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.reopen-allocation",
        argsSchema: {
          allocation_id: { label: "The reservation's id", type: "text" },
        },
      },
      {
        id: "inventory:settle-allocation",
        examples: ["we used the reserved ones", "release that reservation"],
        undoable: true,
        label: "Consume or release a reservation",
        description:
          "Finish a reservation. `status: \"consumed\"` means the stock was actually used: on-hand drops by the reserved amount and a withdrawal appears on the part's statement. `status: \"released\"` means it was not used after all: nothing moves, the reservation just goes away. Pass `allocation_id`. Only a still-reserved allocation can be settled.",
        icon: "check-circle",
        scope: "workspace" as const,
        invokeHandler: "inventory.settle-allocation",
        argsSchema: {
          allocation_id: { label: "The reservation's id", type: "text" },
          status: { label: "consumed or released", type: "text" },
        },
      },
      {
        id: "inventory:add-category",
        examples: ["add a Fasteners category", "we need a new category"],
        undoable: true,
        label: "Add a category",
        description:
          "Create an inventory category (the grouping a part belongs to, e.g. \"Fasteners\"). Pass `name`, optionally `color` as a hex code. Asking for one that already exists returns the existing one rather than failing.",
        icon: "folder-plus",
        scope: "workspace" as const,
        invokeHandler: "inventory.add-category",
        argsSchema: {
          name: { label: "Category name", type: "text" },
          color: { label: "Colour (hex, optional)", type: "text" },
        },
      },
      {
        id: "inventory:create-item",
        examples: ["add a box of screws", "I have got a new spool"],
        undoable: true,
        label: "Add an item",
        description:
          "Create an inventory item in an instance (name + custom fields (metadata) + an optional location / brand / qty. The canonical CREATE a custom (Tier B) app block performs (there was no invokable create before) only set-status / adjust-stock). Generic: the caller composes the name + fields and decides what to make. User-invokable so a granted worker can run it. Args: { instance, name, fields?, location_id?, manufacturer?, qty?, unit? }.",
        // Creating a NEW item is not an operation on an existing one, so this
        // is workspace-scoped. PartDetailPage used to hand-exclude it (and
        // create-items) from its action bar for exactly this reason; that
        // workaround only protected that one page, while every other detail
        // page still showed it.
        scope: "workspace" as const,
        invokeHandler: "inventory.create-item",
        userInvokable: true,
        argsSchema: {
          instance: { label: "Instance (table) name", type: "text" },
          name: { label: "Item name", type: "text" },
        },
      },
      {
        id: "inventory:create-items",
        examples: ["add these five things", "add a batch of items"],
        label: "Add items (bulk)",
        description:
          "Bulk-create N inventory items in one INSERT (a kit BOM, a CSV import, a batch from another module). Returns the new ids in input order so the caller can wire pairings. Does NOT fan out per-item created events. Generic. Args: { items: [{ name, instance?, fields?, qty?, unit?, image_path?, manufacturer?, location_id? }] }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.create-items",
        userInvokable: true,
      },
      {
        id: "inventory:update-item",
        examples: ["rename that part", "change its brand"],
        undoable: true,
        label: "Update an item",
        description:
          "Set a part's name / brand / location and/or MERGE metadata fields (e.g. mark a kit's metadata.lifecycle='parted-out'). The companion to create-item: lets a Tier-B app or another module edit an item through inventory's public interface. Generic. Args: { id, name?, manufacturer?, location_id?, fields? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.update-item",
        userInvokable: true,
      },
      {
        id: "inventory:lift-to-type",
        examples: ["turn these items into types", "dedupe these into product types"],
        label: "Lift items into types",
        description:
          "Bundle-migration engine: lift each item in a SOURCE instance into a TYPE in another instance (deduped by key fields, copying the type-defining fields up, linked via a pairing, optionally converting the qty unit. How a flat single-instance bundle upgrades into a type→instances model on a version bump. Idempotent (skips already-linked items). Generic) the bundle's migration declares the params. Args: { source_instance, type_instance, key_fields[], copy_fields?[], relationship_kind?, convert_qty?: { from_unit, to_unit, factor } }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.lift-to-type",
        // Migration-only: run by the bundle-upgrade flow, never a detail button.
        userInvokable: false,
      },
      {
        id: "inventory:field-to-location",
        examples: ["move the Room field into Location", "turn that place field into real locations"],
        label: "Move a place field into Location",
        description:
          "Bundle-migration engine: retire a bundle's bespoke place field (e.g. a 'Room' text field) into the platform's canonical Location: for each item with a value, find-or-create a matching Location AREA, file the item into it (location_id), then clear the field. How a bundle drops a location-shaped custom field for the real Location on a version bump. Idempotent + safe: never invents a place, never overwrites an already-filed item, re-uses an existing same-named area. Args: { field, instance }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.field-to-location",
        // Migration-only: run by the bundle-upgrade flow, never a detail button.
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
      // A completed print deducts the filament it consumed. digifab's
      // print.completed payload carries { partId, delta } when the job declared
      // a material; adjust-stock reads them off the payload. Inert for a print
      // with no declared material (partId null → the handler skips), and for
      // any workspace without digifab (the event never fires) — same shape as
      // the order-arrival wire above. The wire belongs to inventory: it owns
      // the action.
      {
        source_kind: "digifab:job",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "digifab.print.completed",
      },
      // F-13 — the reverse: a print SCRAPPED at the bed-clear step fires
      // digifab.print.reversed carrying { partId, delta: +grams }, adding the
      // filament back that print.completed optimistically deducted. Same handler,
      // mirrored payload. Inert when the scrapped print declared no material.
      {
        source_kind: "digifab:job",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "digifab.print.reversed",
      },
    ],
  },

  // P3 — the hourly burn-rate sweeper: reads the consumption ledger, predicts
  // each part's run-out date, and fires inventory.stock.predicted-low ahead of
  // empty. Started at boot; only touches orgs with inventory enabled + parts
  // with a consume history, so idle workspaces pay nothing.
  lifecycle: {
    onBoot: async () => {
      const { startBurnRateSweeper } = await import("./burn-rate.js");
      startBurnRateSweeper();
      // Catalog instances the camera sheet latched to the stock face go back to
      // the catalog face. One-shot and idempotent; meta-only for a workspace
      // with nothing to heal. Awaited rather than fired off: it is a few
      // queries, and a half-healed workspace serving its first request is worse
      // than a boot that takes a moment longer.
      const { healCatalogStockLatch } = await import("./heal-catalog-stock-latch.js");
      const unlatched = await healCatalogStockLatch();
      if (unlatched > 0) {
        console.log(`[inventory] ${unlatched} catalog instance(s) returned to the catalog face`);
      }
    },
    onShutdown: async () => {
      const { stopBurnRateSweeper } = await import("./burn-rate.js");
      stopBurnRateSweeper();
    },
  },
});
