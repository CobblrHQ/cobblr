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
import { PART_FIELD_LABELS } from "./part-field-labels.js";

export default defineModule({
  name: "inventory",
  version: "0.22.6",
  displayName: "Inventory",
  description:
    "Parts and supplies: how many you have, where they are kept, and what is running low.",
  icon: "boxes",
  band: "stock",
  instanceability: "multi",
  // A place's page carries inventory's "Stock here" panel.
  operatesOn: ["core-locations", "digifab"],

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
        // inventory_categories is this kind's own taxonomy (category_id, the
        // list's filter, the sync engine's mirror); see categoryAxis.
        categoryAxis: "inventory:category",
        listEndpoint: "/parts",
        createEndpoint: "/parts",
        updateEndpoint: "/parts/{id}",
        deleteEndpoint: "/parts/{id}",
        deleteBy: "admin",
        displayName: "Part",
        displayNamePlural: "Parts",
        icon: "boxes",
        profile: "stock-material" /* physical · fungible · containable · timeless · indefinite · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "state", type: "text", readOnly: true },
          { name: "qty", type: "number", label: PART_FIELD_LABELS.qty, role: "quantity", trait: "fungible" },
          { name: "unit", type: "text", role: "unit", trait: "fungible" },
          { name: "cost", type: "number", money: "amount", aggregate: "per_unit", trait: "fungible" },
          { name: "min_qty", type: "number", label: PART_FIELD_LABELS.min_qty, aggregate: "none", trait: "fungible" },
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
          // Derived on read: a create or update that sends it lands it in
          // metadata as a stray key, so anything writing a part leaves it out.
          { name: "category_name", type: "text", readOnly: true },
          // Where it lives, by name (resolved from location_id through the
          // platform). Derived on read, like category_name.
          { name: "location_name", type: "text", readOnly: true },
          // What of it is free: reserved for projects (assigned) and the rest
          // (available), derived on read like the parts list's own columns, so
          // a module matching a pattern's yarn sees what the stash page sees.
          { name: "assigned_qty", type: "number", readOnly: true },
          { name: "available_qty", type: "number", readOnly: true },
          // What of it is installed in an asset or machine (2 sticks in a
          // computer) and what is on hand, and in what: derived on read from
          // placement, so a view can hide what has nothing on hand and the
          // assistant can say where the rest went.
          { name: "installed_qty", type: "number", readOnly: true },
          { name: "spare_qty", type: "number", readOnly: true },
          { name: "installed_in", type: "object", readOnly: true },
          { name: "sheet_geometry", type: "object", readOnly: true },
          { name: "stock", type: "object", readOnly: true },
          { name: "stock_used", type: "number", readOnly: true },
          { name: "storage_readiness", type: "object", readOnly: true },
          // Which of the workspace's tables (instances) it is in: yarn or hooks.
          { name: "instance", type: "text", readOnly: true },
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
        // supplier_url (procurement detail), notes (free-text).
        // What the person wrote for themselves: their own assistant (Cobb, MCP
        // as that member) may read it to answer them, on their own records
        // only; it never reaches another module, a share or another person
        // (#4798, the owner's decision).
        assistantReadableFields: ["notes"],
        exposableFields: [
          "name",
          "state",
          "description",
          // Who made it. Once withheld with supplier_url as procurement
          // detail, but a brand is on the thing itself and already the part's
          // subtitle everywhere, and withholding it left the one label that
          // names it (Printer Parts, "{{manufacturer}} {{voltage}}") printing a
          // blank where the maker goes (#3600). Where you BUY it stays private.
          "manufacturer",
          "qty",
          "unit",
          "min_qty",
          "image_path",
          // A grouping, not a secret: what a thing is filed under is how
          // another module (or the assistant) tells rice from screws.
          "category_name",
          // Where it lives, by name: the answer to "where is my lamp".
          "location_name",
          "assigned_qty",
          "available_qty",
          "installed_qty",
          "spare_qty",
          "installed_in",
          "sheet_geometry",
          "stock",
          "stock_used",
          "instance",
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

  dependencies: [],

  exposes: {
    notifications: [
      { eventType: "inventory.low-stock", label: "Running low", description: "A daily summary of items at or below their minimum stock." },
    ],
    events: [
      "inventory.part.created",
      "inventory.package.received",
      "inventory.part.updated",
      "inventory.part.deleted",
      "inventory.stock.changed",
      // What a one-tap mark MEANT, in a consumption ledger's vocabulary
      // (purchase / consume / discard). Same shape as core-scan.stock.observed.
      "inventory.stock.observed",
      "inventory.stock.recovered",
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
    actions: [
      // UI-SCREEN: /station/inspection/<machineId>/<orderId> records board evidence and the tested-stock handoff.
      {
        id: "inventory:finish-assembly-stock",
        changes: "records",
        runBy: "member",
        examples: ["finish the tested board transfer"],
        group: "plan", label: "Move inspected boards into tested stock", description: "Settle an immutable native work order inspection transfer once. Only accepted boards move from placed to tested stock.", scope: "workspace", invokeHandler: "inventory.finish-assembly-stock", userInvokable: true, argsSchema: {source_id: {label: "Work order id", type: "text", required: true}, source_kind: {label: "Work order kind", type: "text", required: true}, input_kind: {label: "Placed stock kind", type: "text", required: true}, input_id: {label: "Placed stock id", type: "text", required: true}, output_kind: {label: "Tested stock kind", type: "text", required: true}, output_id: {label: "Tested stock id", type: "text", required: true}, accepted: {label: "Accepted board count", type: "number", required: true}}},
      {
        group: "stock",
        id: "inventory:consume-with-loss",
        changes: "records",
        grantedAs: "inventory:update-part",
        examples: ["the run placed these components", "record these placements and setup loss"],
        label: "Consume placements",
        scope: "workspace",
        description: "Consume placements plus each package's attrition percentage atomically. Expired stock and insufficient counts refuse the whole run. Repeating the sourceId leaves counts unchanged. Args: { sourceId, lines: [{ partId, placements }] }.",
        invokeHandler: "inventory.consume-with-loss", userInvokable: true,
        argsSchema: { sourceId: { label: "Run identifier", type: "text", required: true }, lines: { label: "Stock records and placement counts", type: "json", required: true } },
      },
      {
        group: "stock",
        id: "inventory:receive-package",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /receive-package gates on this action's own id (package-receiving.ts), so a grant of it is the only member door at both
        runBy: "admin",
        examples: ["this bag just arrived", "receive the components from this label"],
        label: "Receive a package",
        description: "Decode a distributor label locally and receive count stock under its part type. Repeating a receipt leaves stock unchanged. Args: { instance, code, receipt_key?, partId?, quantity?, identity?, fields?, packaging?, storage?, exposed_hours?, location_id? }.",
        scope: "workspace",
        invokeHandler: "inventory.receive-package",
        userInvokable: true,
        argsSchema: {
          instance: { label: "Package collection", type: "text", required: true },
          code: { label: "Distributor label", type: "text", required: true },
          receipt_key: { label: "Distinct receipt identifier", type: "text" },
          partId: { label: "Existing package to top up", type: "text" },
          quantity: { label: "Quantity", type: "number" },
          identity: { label: "Part number", type: "text" },
          fields: { label: "Confirmed label fields", type: "json" },
          packaging: { label: "Packaging", type: "text" },
          storage: { label: "Storage", type: "text" },
          exposed_hours: { label: "Previous exposure in hours", type: "number" },
          location_id: { label: "Storage location", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:change-storage",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /:id/storage gates on this action's own id (storage.ts)
        runBy: "admin",
        examples: ["this is out of dry storage", "back in the dry cabinet", "start this stock's bake timer"],
        label: "Change storage",
        description: "Record opening stock, returning it to dry storage, or a timed bake. A bake completes only after its recorded duration. Args: { partId, revision, operation, minutes?, temperature_c?, instruction? }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.change-storage",
        userInvokable: true,
        argsSchema: {
          partId: { label: "Stock record", type: "text", required: true },
          revision: { label: "Current storage revision", type: "number", required: true },
          operation: { label: "Storage change", type: "text", required: true },
          minutes: { label: "Bake duration in minutes", type: "number" },
          temperature_c: { label: "Bake temperature in Celsius", type: "number" },
          instruction: { label: "Manufacturer bake instruction", type: "text" },
        },
      },
      // DECLARED IN THE ORDER A PERSON WANTS THEM. The record's strip shows the
      // first few in the open and folds the rest. One button per gesture: the
      // perishable/durable difference is decided inside the handler from the
      // record ("Used up" ends a lot or empties a bin; "Replaced" swaps a
      // fresh lot in or stamps a spare), never by a second button. The
      // wire-only aliases that used to be buttons sit after the visible set.
      {
        group: "stock", primary: true,
        id: "inventory:use-one",
        changes: "records",
        stockMove: "use",
        examples: ["used one", "I just took one out"],
        undoable: true,
        label: "Use one",
        face: "stock",
        description:
          "Knock a single unit off a part's on-hand qty: the zero-friction 'I took one out' tap, for ONE of several. Binary, no number entry (that's Adjust stock). Decrements through the same path as adjust-stock, so it writes the usage ledger and the low-stock automation still fires. Args: { note? } - a note about this one (how it tasted, what it was for), kept dated on the use's statement line. Not for marking or tagging a thing as low (that is core-tags:tag-record), and not for the last one (that is Used up).",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.use-one",
        userInvokable: true,
        argsSchema: {
          note: { label: "A note about this one", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:mark-opened",
        changes: "records",
        grantedAs: "inventory:update-part",
        examples: ["opened it", "cracked open the pesto", "started this one"],
        undoable: true,
        label: "Mark one as opened",
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
        group: "stock",
        id: "inventory:use-up",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["used it up", "that is all gone", "ate the last one"],
        undoable: true,
        finishes: "used",
        label: "Used up",
        face: "stock",
        description:
          "One verb for the end of a thing, whatever kind of thing it is. On something that goes off (a table with an expiry field, lots dated on arrival) it ends the OLDEST lot as used (or the one lot a Going-off row names), records how long it lasted as a lower bound on its shelf life, and takes one off the count - the same bookkeeping mark-finished does. On plain stock it empties the count. Args: { partId?, timezone?, lot_received_on?, lot_expires_on?, lot_number? }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.use-up",
        argsSchema: {
          partId: { label: "Which item, defaults to the record this ran on", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
          lot_received_on: { label: "The lot to take it from: the day it arrived, from the Going-off list", type: "text" },
          lot_expires_on: { label: "The lot to take it from: its date, from the Going-off list", type: "text" },
          lot_number: { label: "The lot to take it from: the number printed on the box", type: "text" },
        },
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:mark-spoiled",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["it went bad", "had to bin it", "this one spoiled before I got to it"],
        undoable: true,
        finishes: "discarded",
        label: "Threw it out",
        face: "perishable",
        description:
          "Record that one went bad and was binned. This is the only thing that MEASURES how long something keeps, so it is what teaches the shelf life; it also files a waste event, which is what tells you when you are consistently buying more than you get through. With no lot named it is the oldest one; a Going-off row names its own lot and that one goes. Args: { partId?, timezone?, lot_received_on?, lot_expires_on?, lot_number? }.",
        // Only where something CAN go off: a table whose bundle marked a field as
        // the expiry role ("Best before", "Use by"). Scoped to the whole kind,
        // this offered "Threw it out" on a box of screws (audit, 2026-09-08).
        appliesTo: { hasFieldRole: "expiry" },
        invokeHandler: "inventory.mark-spoiled",
        userInvokable: true,
        argsSchema: {
          partId: { label: "Which item", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
          lot_received_on: { label: "The lot to take it from: the day it arrived, from the Going-off list", type: "text" },
          lot_expires_on: { label: "The lot to take it from: its date, from the Going-off list", type: "text" },
          lot_number: { label: "The lot to take it from: the number printed on the box", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:still-good",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["it's still fine", "checked it, still good", "the milk is ok for a few more days"],
        undoable: true,
        finishes: "still-good",
        label: "Still good",
        face: "perishable",
        description:
          "Record that one past (or near) its date was checked and is still fine: its date moves to a few days from today (from its own date when that is later), so it stops asking until then. Only the oldest dated lot moves. Args: { days? (default 3), partId?, timezone? }.",
        appliesTo: { hasFieldRole: "expiry" },
        invokeHandler: "inventory.still-good",
        userInvokable: true,
        argsSchema: {
          days: { label: "How many more days", type: "number" },
          partId: { label: "Which item", type: "text" },
          timezone: { label: "Timezone to date it in", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:restock-one",
        changes: "records",
        stockMove: "add",
        grantedAs: "inventory:count-stock",
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
        group: "stock",
        id: "inventory:replaced",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["replaced the filter", "swapped in a new box", "replaced it with a fresh one"],
        undoable: true,
        label: "Record a replacement",
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
        group: "stock",
        id: "inventory:set-status",
        changes: "records",
        editor: true,
        grantedAs: "inventory:update-part",
        examples: ["mark it as built", "set that to missing pieces"],
        undoable: true,
        label: "Set status",
        description:
          "Set a part's `metadata.status` (e.g. a Lego set's Built / Unbuilt / Missing pieces), or another state field its table declares, such as the Lego Sets table's `lifecycle`, to one of that field's choices. A member-appropriate, user-invokable action: grant it and a worker can update state from their app: the canonical write a custom (Tier B) app block performs. Args: { partId?, status, field? }; partId falls back to the targeted entity, field defaults to status.",
        appliesTo: { kinds: ["inventory:part"], requires: { traits: ["physical"] } },
        invokeHandler: "inventory.set-status",
        argsSchema: {
          partId: { label: "Which part, defaults to the record this ran on", type: "text" },
          status: { label: "The status to set", type: "text", required: true },
          field: { label: "Which state field, when not status (the Lego Sets table's lifecycle)", type: "text" },
        },
        userInvokable: true,
      },
      {
        // UI-SCREEN: /builds/<revision> reserves, reads and cancels native kits through the assembly work order actions.
        id: "inventory:assembly-kit", changes: "records", group: "plan", label: "Reserve or check an assembly kit", description: "Atomically reserve count stock for an assembly work order, check fresh storage and quantities, or settle the whole kit once. Individual kit allocations cannot be settled separately.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "inventory.assembly-kit", userInvokable: true,
        argsSchema: {
          target_kind: { label: "Work order kind", type: "text", required: true },
          target_id: { label: "Assembly work order id", type: "text", required: true },
          operation: { label: "reserve, check, release or consume", type: "text", required: true },
          lines: { label: "Stock lines with part_id, kind and qty", type: "json" },
          confirmed_placed: { label: "The physical placement already happened; retain late moisture warnings while recording actual stock movement", type: "boolean" },
          output: { label: "Placed-board stock with part_id, kind and qty, required for consumption", type: "json" },
          require_ready: { label: "Refuse an unusable kit", type: "boolean" },
        },
      },
      {
        // UI-SCREEN: /builds/<revision> invokes this draw through its recorded paste application.
        // NO-PHRASING: the native assembly application supplies its captured lot and stable receipt key.
        id: "inventory:use-ready-paste", changes: "records", group: "stock", label: "Use applied paste", description: "Draw liquid paste under its stock lock after checking fresh handling and expiry. The application key records one draw and recovers a lost reply.", scope: "workspace" as const, invokeHandler: "inventory.use-ready-paste", userInvokable: false,
        runBy: "member",
        argsSchema: { partId: { label: "Paste jar id", type: "text", required: true }, amount_ml: { label: "Amount in ml", type: "number", required: true }, sourceId: { label: "Application receipt key", type: "text", required: true }, lot: { label: "Captured paste lot", type: "text", required: true }, revision: { label: "Captured handling revision", type: "number", required: true } },
      },
      {
        id: "inventory:change-paste", changes: "records", group: "stock", label: "Record paste handling", description: "Record a liquid paste jar's immutable lot and label limits, take it out of refrigeration, open it after warming, or return an unopened jar to cold storage. Clocks cannot be reset by repeated handling.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "inventory.change-paste", userInvokable: true,
        argsSchema: {
          partId: { label: "Paste jar id", type: "text", required: true },
          revision: { label: "Current handling revision", type: "number", required: true },
          operation: { label: "configure, out, cold or open", type: "text", required: true },
          limits: { label: "Label lot, expires_on, timezone, warmup_hours and work_life_hours", type: "json" },
        },
      },
      {
        // UI-SCREEN: /instances/solder-paste/parts/<id> reads this readiness through the shared GET paste reader.
        id: "inventory:paste-readiness", changes: "records", group: "stock", label: "Check paste readiness", description: "Read a jar's handling history, warm-up deadline, remaining work life and shelf expiry. Changes nothing.",
        runBy: "member",
        scope: "workspace" as const, invokeHandler: "inventory.paste-readiness", userInvokable: true,
        argsSchema: { partId: { label: "Paste jar id", type: "text", required: true } },
      },
      {
        group: "plan",
        id: "inventory:reserve-stock",
        changes: "records",
        runBy: "member",
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
          qty: { label: "How much to reserve", type: "number", required: true },
          for_kind: { label: "Kind it is reserved for (e.g. projects:project)", type: "text", required: true },
          for_id: { label: "Id of that record", type: "text", required: true },
          reason: { label: "What it is for (shown on the statement)", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:split-lot",
        changes: "records",
        grantedAs: "inventory:create-part",
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
      // One thing kept in several places (docs/design-decisions/holdings-and-units.md).
      // Each is a panel gesture on the record's detail; these are the same
      // moves for the assistant and a wire.
      {
        group: "stock",
        id: "inventory:add-holding",
        changes: "records",
        grantedAs: "inventory:create-part",
        examples: ["we also keep saline in ambulance 3", "keep 10 of these in the van too"],
        label: "Keep it somewhere else too",
        face: "stock",
        description:
          "This item is also kept at another location: add a row for that place, with its own count and minimum, under the same item (one card, a row per place). Refused when it is already kept there. Args: { location_id (a core-locations:location id), qty?: number, min_qty?: number }.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.add-holding",
        userInvokable: false,
        argsSchema: {
          location_id: { label: "Where", type: "text", required: true },
          qty: { label: "How many there", type: "number" },
          min_qty: { label: "Minimum there", type: "number" },
        },
      },
      {
        group: "stock",
        id: "inventory:combine-holdings",
        changes: "records",
        grantedAs: "inventory:create-part",
        examples: ["the gauze in the closet and in ambulance 2 are the same thing", "combine these into one item"],
        label: "Combine into one item",
        face: "stock",
        description:
          "These other records are the same thing kept at other places: make each a row of this item, so it reads as one card with a row per place. Never done without being asked. Refused when two would sit at the same place. Args: { ids: list of the other records' ids }.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.combine-holdings",
        userInvokable: false,
        argsSchema: {
          ids: { label: "The same thing elsewhere", type: "list", required: true },
        },
      },
      {
        group: "stock",
        id: "inventory:split-holding",
        changes: "records",
        grantedAs: "inventory:create-part",
        examples: ["the stock in the van is its own thing", "split this place out"],
        label: "Split into its own",
        face: "stock",
        description:
          "This place's stock stops being a row of its item and becomes a record of its own, keeping its count, minimum and history. Run it on the place's record.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.split-holding",
        userInvokable: false,
      },
      {
        group: "stock",
        id: "inventory:move-all-stock",
        changes: "records",
        grantedAs: "inventory:update-part",
        examples: ["move all the saline to the van", "everything we have of this goes to the garage"],
        label: "Move it all to one place",
        face: "stock",
        description:
          "Move everything this item holds, in every place, into one location: every lot keeps its expiry and lot number, each end gets a ledger line, the item is then kept at that location only, and the places it emptied are archived, never deleted. Run it on the item or any of its places. Args: { to_location_id: the location }.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.move-all-stock",
        userInvokable: false,
        argsSchema: {
          to_location_id: { label: "To (a location)", type: "text", required: true },
        },
      },
      {
        group: "stock",
        id: "inventory:transfer-stock",
        changes: "records",
        grantedAs: "inventory:update-part",
        examples: ["restock ambulance 3 from the closet", "move 5 bags of saline to the van"],
        label: "Restock from another place",
        face: "stock",
        description:
          "Move stock between two places of the same item. The soonest-expiring lot goes first unless one is named, and every lot keeps its expiry and lot number; both places get a ledger line. A place the item is not kept yet is added. Run it on the place the stock LEAVES. Args: { to_id?: the receiving place's record id, to_location_id?: or the receiving location, qty: number, lot?: a lot number, expires_on?: or a lot's expiry date }.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.transfer-stock",
        userInvokable: false,
        argsSchema: {
          to_id: { label: "To (a place of this item)", type: "text", oneOf: "to" },
          to_location_id: { label: "To (a location)", type: "text", oneOf: "to" },
          qty: { label: "How many", type: "number", required: true },
          lot: { label: "Lot number", type: "text" },
          expires_on: { label: "Or the lot's expiry date", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:receive-lot",
        changes: "records",
        grantedAs: "inventory:update-part",
        examples: ["12 bags of saline arrived, expiring 2027-02-25, lot B-220", "we got 20 more, use by March"],
        label: "Stock arrived",
        face: "stock",
        description:
          "Stock arrived at this place: add it as a lot with the expiry printed on it (or, without one, today plus the item's shelf life) and its lot number when there is one. Args: { qty: number, expires_on?: YYYY-MM-DD, lot?: string }.",
        appliesTo: { traits: ["fungible"] },
        invokeHandler: "inventory.receive-lot",
        userInvokable: false,
        argsSchema: {
          qty: { label: "How many arrived", type: "number", required: true },
          expires_on: { label: "Expiry printed on it", type: "text" },
          lot: { label: "Lot number", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:mark-finished",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["ate the last one", "that's the end of the jar", "all gone"],
        undoable: true,
        label: "Finished it",
        face: "perishable",
        description:
          "Record that you used the last of one up. Counts as a LOWER BOUND on how long it keeps - it lasted at least this long - and never as a measurement, because you ate it rather than testing it. Args: { partId?, timezone?, lot_received_on?, lot_expires_on?, lot_number? }.",
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
          lot_received_on: { label: "The lot to take it from: the day it arrived, from the Going-off list", type: "text" },
          lot_expires_on: { label: "The lot to take it from: its date, from the Going-off list", type: "text" },
          lot_number: { label: "The lot to take it from: the number printed on the box", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:swap-fresh",
        changes: "records",
        grantedAs: "inventory:count-stock",
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
        // UI-SCREEN: /station/stock/:station reads the same stock list through its GET route.
        group: "stock", id: "inventory:list-stock", changes: "records", label: "List workshop stock",
        runBy: "member",
        examples: ["show me the spools", "what stock is loaded at the cutter"],
        description: "Read workshop stock across Inventory collections by shape or name. Pass fields with optional shape (sheet, roll, spool, liquid, wearing-tool or count), q, station, limit and offset. Returns remaining amounts, units, thresholds, total and loaded station slots. Continue with offset when complete is false.",
        scope: "workspace", invokeHandler: "inventory.list-stock", userInvokable: false, effect: "none", undoable: true,
        argsSchema: { fields: { label: "Stock filters", type: "json", required: true } },
      },
      {
        group: "stock", id: "inventory:configure-stock", changes: "records", grantedAs: "inventory:update-part", label: "Set stock shape",
        examples: ["this is a roll of white vinyl", "set this bit's life to ten hours"],
        description: "Set a sheet, roll, spool, liquid, wearing-tool or count shape, its threshold and remaining amount. Pass fields with config (shape, low_threshold and shape fields), revision from the stock field, and optional remaining or used recount. Rolls take width_mm and waste in metres; spools take unit g or m and optional grams_per_m; wearing tools take unit h, uses or m and limit. Sheet dimensions go in sheet. Used stock keeps its shape and unit.",
        appliesTo: { kinds: ["inventory:part"] }, invokeHandler: "inventory.configure-stock", userInvokable: false,
        argsSchema: { fields: { label: "Stock shape and recount", type: "json", required: true } },
      },
      {
        group: "stock", id: "inventory:consume-stock", changes: "records", grantedAs: "inventory:update-part", label: "Record stock use",
        examples: ["the job used two metres of vinyl", "that scrap used thirty ml of resin"],
        description: "Record stock used by a job, including scrap. Pass fields with a unique source per job and stock draw, verdict good or scrap, amount and unit. Roll waste is added once; override waste in the stock unit if measured. Spools convert g and m only with grams_per_m. Sheet use takes rectangles in mm, kerf_mm and spacing_mm, and the sheet revision it was planned against. Repeating a source never consumes twice; a shortage refuses the write.",
        appliesTo: { kinds: ["inventory:part"] }, invokeHandler: "inventory.consume-stock", userInvokable: false,
        argsSchema: { fields: { label: "Job stock use", type: "json", required: true } },
      },
      {
        group: "stock", id: "inventory:load-stock", changes: "records", grantedAs: "inventory:update-part", label: "Confirm loaded stock",
        examples: ["this white vinyl is loaded at the cutter", "unload this spool"],
        description: "Confirm stock is physically loaded at a named station and slot, or unload it. Pass fields with station, optional slot (a colour or feed position) and loaded true or false. This records stock placement and grants no permission to start a machine.",
        appliesTo: { kinds: ["inventory:part"] }, invokeHandler: "inventory.load-stock", userInvokable: false,
        argsSchema: { fields: { label: "Station and slot", type: "json", required: true } },
      },
      {
        group: "stock",
        id: "inventory:change-sheet-area",
        changes: "records",
        grantedAs: "inventory:update-part",
        label: "Record sheet area",
        description: "Record cut outlines already offset for kerf and spacing, or bounding boxes with kerf and spacing, edit the free rectangles, or undo the latest hand edit. Supply the current revision to prevent stale changes.",
        examples: ["record this sheet cut", "undo the hand edit to this sheet"],
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.change-sheet-area",
        userInvokable: false,
        argsSchema: { partId: { label: "Sheet id", type: "text" }, operation: { label: "Change", type: "text" }, revision: { label: "Current revision", type: "number" }, rectangles: { label: "Rectangles in millimetres", type: "json" }, outlines: { label: "Offset cut outlines in millimetres", type: "json" }, kerf_mm: { label: "Kerf (mm)", type: "number" }, spacing_mm: { label: "Spacing (mm)", type: "number" }, source: { label: "Cut reference", type: "text" } },
      },
      {
        group: "stock",
        id: "inventory:measure-material",
        changes: "records",
        // ADMIN-ONLY: the page's own routes POST /:id/material and PUT /spool/:id/use gate on this action's own id (material.ts, spool-native.ts)
        runBy: "admin",
        examples: ["this spool weighs 750 grams", "used 1200 millimetres of filament"],
        label: "Measure filament",
        description: "Weigh a spool including its empty spool, or record filament used in millimetres. Uses the type's density, diameter and empty spool weight. A weighing is a recount, not consumption.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.measure-material",
        userInvokable: true,
        argsSchema: {
          partId: { label: "Item id", type: "text" },
          gross_g: { label: "Scale reading (g)", type: "number" },
          used_mm: { label: "Used length (mm)", type: "number" },
        },
      },
      {
        group: "stock",
        id: "inventory:adjust-stock",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["add 5 to the M3 screws", "take 2 off that spool"],
        undoable: true,
        label: "Adjust part stock",
        description:
          "Add or subtract from a part's on-hand qty. Wire it to purchases.order_item.received for auto-bump-on-arrival, or fire it from any other event source. Args: { partId, delta, reason?, restock?, lots?, once?, reversible?, takeBack?, sourceKind?, sourceId? }, or { draws: [{ partId, quantity, optional }], reason? } for an atomic component draw. Required draws move in full or the entire draw rolls back; optional draws take what is available. lots: [{ lot, qty }], how many of the arriving units carry which batch number; each becomes a lot of its own. With restock: true (set in the args, or carried by the event, as a received purchase does) a positive delta is stock that arrived: a lot dated today, good until today plus the item's shelf life, and the record's bought-on date moves to today. Anything arriving on an empty record is dated the same way.",
        // Tightened from { any: true } to inventory:part-only — wire
        // can still hit it for any source via target traversal, but
        // the manual-button surface stays scoped.
        appliesTo: { kinds: ["inventory:part"], requires: { traits: ["physical"] } },
        invokeHandler: "inventory.adjust-stock",
        // Wire-driven only — clicking it on an arbitrary entity
        // doesn't make sense; the user has stock-adjust HTTP for
        // direct edits.
        userInvokable: false,
        // Drives the wire composer's structured "With" form. Values can be
        // literals or {{tokens}} (e.g. delta = {{event.delta}}), rendered at
        // fire time against the event payload + target entity.
        // Fired by a wire with no args of its own, it takes the part and the
        // amount off the event.
        readsFromEvent: ["partId", "delta"],
        argsSchema: {
          unit: { label: "The unit delta is in (\"g\"); converted to the thing's own unit first", type: "text" },
          operationKey: { label: "Receipt key for a recoverable stock draw", type: "text" },
          once: { label: "Apply once per source: a repeat for the same thing, source and direction changes nothing", type: "boolean" },
          reversible: { label: "With once: the source can take it back, so a repeat is judged on what it has done net (a shopping line unticked, then ticked again)", type: "boolean" },
          takeBack: { label: "Take back whatever this source has added, net (a shopping line unticked); delta is ignored", type: "boolean" },
          partId: { label: "Part id", type: "text" },
          delta: { label: "Change in qty (+ adds, − subtracts)", type: "number" },
          restock: { label: "This is stock that arrived: date it today (optional)", type: "boolean" },
          draws: { label: "Atomic stock draw: [{ partId, quantity, optional }] (optional)", type: "json" },
          lots: { label: "Of the units arriving, how many carry which lot or batch number, as their boxes printed it: [{ lot, qty }] (optional)", type: "json" },
          timezone: { label: "Timezone to date arriving stock in (optional)", type: "text" },
          reason: { label: "Reason (optional)", type: "text" },
          correction: { label: "This sets the count to what is actually there, a recount: filed as a correction, never as use or a purchase (optional)", type: "boolean" },
          sourceKind: { label: "Record kind this adjustment came from (optional)", type: "text" },
          sourceId: { label: "Record id this adjustment came from (optional)", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:set-stock",
        changes: "records",
        stockMove: "total",
        grantedAs: "inventory:count-stock",
        examples: ["there are 40 left", "set the count to 12"],
        undoable: true,
        label: "Set part stock",
        description:
          "Set a part's on-hand qty to an ABSOLUTE value (not a delta). The natural op for a scale ('grams remaining'), a stocktake, or a recount. Reached from core-devices.device.reading via a device→part link, or any source. Args: { partId, qty, reason? }.",
        appliesTo: { kinds: ["inventory:part"], requires: { traits: ["physical"] } },
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
        group: "lifecycle",
        id: "inventory:restore-part",
        changes: "records",
        grantedAs: "inventory:update-part",
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
        group: "stock",
        id: "inventory:remove-category",
        changes: "records",
        runBy: "member",
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
        group: "plan",
        id: "inventory:reopen-allocation",
        changes: "records",
        runBy: "member",
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
        // NO-PHRASING: driven by a consumer module's own record, never asked for
        group: "plan",
        id: "inventory:reserve-for-line",
        changes: "records",
        runBy: "member",
        internal: true,
        label: "Hold stock for one line of a target",
        description: "Internal, driven by a consumer's own record (a pattern's yarn): hold `qty` unopened units of `part_id` for `for_kind` / `for_id` / `for_line`.",
        icon: "bookmark",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.reserve-for-line",
        argsSchema: {
          part_id: { label: "The part", type: "text" },
          qty: { label: "How many units", type: "number" },
          for_kind: { label: "The target kind", type: "text" },
          for_id: { label: "The target id", type: "text" },
          for_line: { label: "The target's line", type: "text" },
          reason: { label: "Statement line", type: "text" },
        },
      },
      {
        // NO-PHRASING: driven by a consumer module's own record, never asked for
        group: "stock",
        id: "inventory:line-usage",
        changes: "records",
        runBy: "member",
        internal: true,
        label: "What each line of a target has used",
        description: "Internal, a read: per line of `for_kind` / `for_id`, what it has used so far, the units held and the open balls bound to it.",
        icon: "bookmark",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.line-usage",
        argsSchema: {
          for_kind: { label: "The target kind", type: "text" },
          for_id: { label: "The target id", type: "text" },
        },
      },
      {
        // NO-PHRASING: driven by a consumer module's own record, never asked for
        group: "stock",
        id: "inventory:use-for-line",
        changes: "records",
        runBy: "member",
        internal: true,
        label: "Use stock for one line of a target",
        description: "Internal, driven by a consumer finishing (a pattern marked done, a yarn swapped halfway): take `measure` (in the part's consumption unit) or `units` of `part_id` for the line, bound balls first, then open partials, then fresh units, each a ledger line on its ball.",
        icon: "bookmark",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.use-for-line",
        argsSchema: {
          part_id: { label: "The part", type: "text" },
          measure: { label: "How much, in the consumption unit", type: "number" },
          units: { label: "How many whole units", type: "number" },
          for_kind: { label: "The target kind", type: "text" },
          for_id: { label: "The target id", type: "text" },
          for_line: { label: "The target's line", type: "text" },
          reason: { label: "Statement line", type: "text" },
        },
      },
      {
        // NO-PHRASING: driven by a consumer module's own record, never asked for
        group: "stock",
        id: "inventory:release-line",
        changes: "records",
        runBy: "member",
        internal: true,
        label: "Let one line of a target go",
        description: "Internal: release the line's reservations and return its bound balls to the pool as open partials. Nothing that was used comes back.",
        icon: "bookmark",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.release-line",
        argsSchema: {
          for_kind: { label: "The target kind", type: "text" },
          for_id: { label: "The target id", type: "text" },
          for_line: { label: "The target's line", type: "text" },
        },
      },
      {
        // NO-PHRASING: driven by a consumer module's own record, never asked for
        group: "stock",
        id: "inventory:settle-target",
        changes: "records",
        runBy: "member",
        internal: true,
        label: "Settle a finished target's reservations",
        description: "Internal, run when a target is done or abandoned: its whole-target reservations of unopened units are consumed (done) or released (abandoned); balls bound to it are released, their use already on their statements.",
        icon: "bookmark",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "inventory.settle-target",
        argsSchema: {
          for_kind: { label: "The target kind", type: "text" },
          for_id: { label: "The target id", type: "text" },
          outcome: { label: "done or abandoned", type: "text" },
        },
      },
      {
        group: "plan",
        // UI-SCREEN: /inventory/* (Consume or Release beside a reservation)
        id: "inventory:settle-allocation",
        changes: "records",
        runBy: "member",
        examples: ["we used the reserved ones", "release that reservation"],
        undoable: true,
        label: "Consume or release a reservation",
        description:
          "Finish a reservation. `status: \"consumed\"` means the stock was actually used: on-hand drops by the reserved amount and a withdrawal appears on the part's statement. `status: \"released\"` means it was not used after all: nothing moves, the reservation just goes away. Pass `allocation_id`. Only a still-reserved allocation can be settled.",
        icon: "check-circle",
        scope: "workspace" as const,
        invokeHandler: "inventory.settle-allocation",
        argsSchema: {
          allocation_id: { label: "The reservation's id", type: "text", required: true },
          status: { label: "consumed or released", type: "text", required: true },
        },
      },
      {
        group: "stock",
        // UI-SCREEN: /inventory/* (Categories in list settings)
        id: "inventory:add-category",
        changes: "records",
        runBy: "member",
        examples: ["add a Fasteners category", "we need a new category"],
        undoable: true,
        label: "Add a category",
        description:
          "Create an inventory category (the grouping a part belongs to, e.g. \"Fasteners\"). Pass `name`, optionally `color` as a hex code. Asking for one that already exists returns the existing one rather than failing.",
        icon: "folder-plus",
        scope: "workspace" as const,
        invokeHandler: "inventory.add-category",
        argsSchema: {
          name: { label: "Category name", type: "text", required: true },
          color: { label: "Colour (hex, optional)", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:create-item",
        changes: "records",
        grantedAs: "inventory:create-part",
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
          name: { label: "Item name", type: "text", required: true },
        },
      },
      {
        group: "stock",
        id: "inventory:create-items",
        changes: "records",
        grantedAs: "inventory:create-part",
        examples: ["add these five things", "add a batch of items"],
        label: "Add items (bulk)",
        description:
          "Bulk-create N inventory items in one INSERT (a kit BOM, a CSV import, a batch from another module). Returns the new ids in input order so the caller can wire pairings. Does NOT fan out per-item created events. Generic. Args: { items: [{ name, instance?, fields?, qty?, unit?, image_path?, manufacturer?, location_id? }] }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.create-items",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:stocktake",
        changes: "records",
        // Taking stock is counting what is there: the member's own stock work.
        grantedAs: "inventory:count-stock",
        examples: ["here's what's left in the fridge: milk, eggs, half the cheddar", "everything else in the pantry is gone", "what's still here?"],
        // Not declared undoable, though it has one Undo: marking a place's
        // things gone is shown on a card and confirmed by the person first.
        label: "Take stock of a place",
        description:
          "What's still here: the person says what is left in a place (or in the records they picked, or among a collection's things with no place) and every other listed record there is marked gone, by today, not recorded how. Never 'finished' or 'threw it out', so shelf-life learning is untouched. Read the place's records first (GET stocktake) and pass their real ids. A partial ('half the cheddar') goes in counted with the quantity left and keeps the record. Something said that is not on record is NOT created here: offer it as a new item first. One Undo restores every record. Marking a whole place gone, or a collection's unplaced things, needs confirm_count set to the number being marked gone. Args: { scope: { place_id, instance? } | { unplaced: true, instance } | { ids }, keep: [id], counted?: [{ id, qty }], confirm_count? }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.stocktake",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:start-recount",
        changes: "records",
        // Recounting a collection is counting what is there: the member's own stock work.
        grantedAs: "inventory:count-stock",
        examples: ["let's recount my filament", "rescan all my PETG from scratch", "recount everything tagged garage in Tools"],
        label: "Recount a collection",
        description:
          "Start a recount of everything in a collection across every place, or of the part of it one category, one tag or one shared saved view takes in, or pick up the one already open over the same scope. Nothing on the records changes while it is open: each thing is scanned in (inventory:recount-scan) and the reconcile at the end is previewed first. Args: { scope: { collection: <collection name or label>, category_id? | tag? (a tag's name) | view_id? (a shared saved view of that collection) } }, at most one of the three. Returns recount_id.",
        scope: "workspace" as const,
        invokeHandler: "inventory.start-recount",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:recount-scan",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["scanned 6970000000011", "that one says Kingroon PETG white", "this is the silver spool"],
        label: "Scan a thing into a recount",
        description:
          "Count one thing found during a recount. Matched strongest first: record_id (a record the person picked), then barcode, then what its label says (text, and attributes such as brand, material, color, diameter). Identical records count one each without asking; two kinds read alike answer result 'ask' with candidates to pick (scan again with record_id); nothing alike answers 'new' and is noted to add at the reconcile. In a collection whose things belong to types (Spools under Filament Types), something new is matched against the types and added under one; two types read alike answer 'ask_type' (scan again with type_id, and new: true). new: true says it is none of the things offered. Optional place_id (where it is now) and amount (how much is left). Args: { recount_id, record_id?, barcode?, text?, attributes?, new?, type_id?, place_id?, amount? }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.recount-scan",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:apply-recount",
        changes: "records",
        grantedAs: "inventory:count-stock",
        // Not declared undoable, though it has one Undo: finishing a recount can
        // mark things gone, so it is shown on a card and confirmed first.
        examples: ["finish the filament recount", "the scan is the truth, apply it", "mark the ones I didn't see gone"],
        label: "Finish a recount",
        description:
          "Finish an open recount (previewed first: the card lists every change). Seen records are confirmed; with truth on, their places and amounts come from the scans. New things are added (new: { <scan_id>: 'add' | 'skip' }, default add), like the type they read as. Not seen records: not_seen: { <record_id>: 'gone' | 'keep' | 'later' }, or not_seen_all for all of them; the default is gone when truth is on, keep when off. Gone is 'gone, not recorded how' (never finished or thrown out). Nothing is deleted, and one Undo (inventory:undo-recount) puts everything back. Args: { recount_id, truth?, not_seen?, not_seen_all?, new? }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.apply-recount",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:undo-recount",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["undo that recount", "put the filament back as it was"],
        label: "Undo a recount",
        description: "Put a finished recount back: things it marked gone are listed again, moves and amounts go back, and things it added are marked gone. Records deleted since stay deleted. Args: { recount_id }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.undo-recount",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:recount-remove-scan",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["that scan was wrong", "take that one back out of the recount"],
        label: "Take a scan out of a recount",
        description: "Take one scan back out of an open recount (a mis-scan or the wrong pick): the record it counted is expected again. Args: { recount_id, scan_id }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.recount-remove-scan",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:undo-stocktake",
        changes: "records",
        grantedAs: "inventory:count-stock",
        examples: ["undo that stocktake", "bring the fridge back"],
        label: "Undo a stocktake",
        description:
          "Put a stocktake back: every record it marked gone is listed again and every count it lowered goes back up by what it took. Records deleted since stay deleted. Args: { stocktake_id }.",
        scope: "workspace" as const,
        invokeHandler: "inventory.undo-stocktake",
        userInvokable: true,
      },
      {
        group: "stock",
        id: "inventory:update-item",
        changes: "records",
        editor: true,
        grantedAs: "inventory:update-part",
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
        group: "stock",
        id: "inventory:lift-to-type",
        changes: "workspace",
        // ADMIN-ONLY: no page twin: a bundle migration that links every item in an instance to a type
        runBy: "admin",
        examples: ["turn these items into types", "dedupe these into product types"],
        label: "Lift items into types",
        description:
          "Bundle-migration engine: lift each item in a SOURCE instance into a TYPE in another instance (deduped by key fields, copying the type-defining fields up, linked via a pairing, optionally converting the qty unit. How a flat single-instance bundle upgrades into a type→instances model on a version bump. Idempotent (skips already-linked items). Generic) the bundle's migration declares the params. Args: { source_instance, type_instance, key_fields[], copy_fields?[], relationship_kind?, convert_qty?: { from_unit, to_unit, factor } }.",
        // Operates on a SET of parts chosen by its args, never on the one
        // record it stands on (#3378).
        scope: "workspace",
        invokeHandler: "inventory.lift-to-type",
        // Migration-only: run by the bundle-upgrade flow, never a detail button.
        userInvokable: false,
      },
      {
        group: "organise",
        id: "inventory:field-to-location",
        changes: "workspace",
        // ADMIN-ONLY: no page twin: a bundle migration that rewrites every item in an instance and makes locations
        runBy: "admin",
        examples: ["move the Room field into Location", "turn that place field into real locations"],
        label: "Move a place field into Location",
        description:
          "Bundle-migration engine: retire a bundle's bespoke place field (e.g. a 'Room' text field) into the platform's canonical Location: for each item with a value, find-or-create a matching Location AREA, file the item into it (location_id), then clear the field. How a bundle drops a location-shaped custom field for the real Location on a version bump. Idempotent + safe: never invents a place, never overwrites an already-filed item, re-uses an existing same-named area. Args: { field, instance }.",
        // A kind-wide migration, not something done TO one part (#3378).
        scope: "workspace",
        invokeHandler: "inventory.field-to-location",
        // Migration-only: run by the bundle-upgrade flow, never a detail button.
        userInvokable: false,
      },
      {
        group: "stock",
        // UI-SCREEN: /inventory/*
        id: "inventory:pull-connected-stock",
        changes: "records",
        // ADMIN-ONLY: the page's own route POST /spoolman/sync is owner or admin (spoolman.ts)
        runBy: "admin",
        examples: ["sync my spools from Spoolman"],
        label: "Sync spools from Spoolman",
        description: "Pull the spools from a connected Spoolman into stock now: new spools are added and remaining weights updated. Its key is never shown.",
        scope: "workspace",
        invokeHandler: "inventory.pull-connected-stock",
        userInvokable: true,
        argsSchema: {
          connection: { label: "Which Spoolman (its name; empty: the only one)", type: "text" },
        },
      },
      {
        group: "stock",
        id: "inventory:add-unit",
        changes: "records",
        runBy: "member",
        // The item page already has Add unit (its Units section); a second
        // button for the same gesture is what one-button-per-gesture refuses.
        userInvokable: false,
        examples: ["add a unit with serial SN-0042"],
        label: "Add a numbered unit",
        description: "Add one physical unit of this item to its list, with its serial number, so each one can be tracked on its own. The item's counted quantity is not changed.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "inventory.add-unit",
        argsSchema: {
          serial_number: { label: "Its serial number", type: "text" },
          name: { label: "Its name (empty: the item's name and serial)", type: "text" },
        },
      },
    ],
  },

  subscribes: ["core-placement.placed"],

  // The "order arrival auto-bumps part stock" flow is a wire, not
  // hardcoded code. Ship it as a default; users can edit / disable
  // / replace it. The wire belongs to inventory because inventory
  // owns the action it fires.
  contributes: {
    // What one place carries, on the place's own page (a vehicle: count
    // against the minimum kept there, what is low, what is going off).
    panels: [
      { id: "inventory:material-cost", surface: "entity-detail-panel" as const, target: "digifab:job", title: "Filament used" },
      {
        id: "inventory:stock-here",
        surface: "entity-detail-panel" as const,
        target: "core-locations:location",
        title: "Stock here",
      },
      // On a stock record: the automations about this one record running out,
      // and "When this runs out…" to add one (#6070, the wire composer).
      {
        id: "inventory:when-it-runs-out",
        surface: "entity-detail-panel" as const,
        target: "inventory:part",
        title: "When this runs out",
        appliesTo: { traits: ["fungible"] },
      },
      // On every saved view of this module's records (a Groceries "What's on
      // hand"): a stocktake of exactly the records the view shows.
      { id: "inventory:stocktake-view", surface: "view-toolbar" as const, target: "inventory", title: "What's still here?" },
      // Recount the things of one collection that carry a tag, over that group of the tag's page (#6819).
      { id: "inventory:recount-tag", surface: "tag-toolbar" as const, target: "inventory", title: "Recount these" },
    ],
    wires: [
      {
        source_kind: "purchases:order_item",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "purchases.order_item.received",
      },
      // The mirror: a line returned to the store leaves the shelf (delta < 0),
      // and an undone return puts it back. purchases sends it once per return.
      {
        source_kind: "purchases:order_item",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "purchases.order_item.returned",
      },
      // A line received too soon, taken back: a receipt filed as arrived was
      // still on its way (a shipping notice came after it). Its stock leaves
      // the shelf (delta < 0) until the parcel really turns up.
      {
        source_kind: "purchases:order_item",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "purchases.order_item.unreceived",
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
      // A print's grams off each spool loaded on its printer: one event per
      // spool, in grams, converted to the spool's own unit by adjust-stock. A
      // scrapped print keeps them off: it melted its filament either way (#7890).
      {
        source_kind: "digifab:job",
        action_id: "inventory:adjust-stock",
        trigger_type: "event",
        trigger_event: "digifab.print.consumed",
      },
    ],
  },

  // P3 — the hourly burn-rate sweeper: reads the consumption ledger, predicts
  // each part's run-out date, and fires inventory.stock.predicted-low ahead of
  // empty. Started at boot; only touches orgs with inventory enabled + parts
  // with a consume history, so idle workspaces pay nothing.
  lifecycle: {
    onBoot: async () => {
      const { registerStockShapesHeal } = await import("./heal-stock-shapes.js");
      registerStockShapesHeal();
      // A name saved with metadata labels or "None" in it is rebuilt (#6283).
      const { registerRecordNamesHeal } = await import("./heal-record-names.js");
      registerRecordNamesHeal();
      const { registerShapedStockShortages } = await import("./stock-shortages.js");
      registerShapedStockShortages();
      const { registerInventoryTidyFinders } = await import("./tidy-finders.js");
      registerInventoryTidyFinders();
      const { registerLowStockAlerts } = await import("./low-stock-alerts.js");
      registerLowStockAlerts();
      const { startBurnRateSweeper } = await import("./burn-rate.js");
      startBurnRateSweeper();
      // A bundle that changes a collection's default count unit (Yarn: skein
      // to ball) has its records still on the old default follow it.
      const { registerDefaultUnitFollows } = await import("./default-unit-follows.js");
      registerDefaultUnitFollows();
      // A type collection and its things (Filament Types + Spools): a scanned
      // spool left in the types table, and a spool with no type, put back.
      const { registerFamiliesHeal } = await import("./heal-families.js");
      registerFamiliesHeal();
      // Parts from before measured values were read get read once, so an old
      // "4k7" answers a search for 4.7 kΩ (heal-measure-readings.ts).
      const { registerMeasureReadingsHeal } = await import("./heal-measure-readings.js");
      registerMeasureReadingsHeal();
      // What its dashboard tiles read, in the one dashboard request (#6563).
      const { registerInventoryDashboardReads } = await import("./dashboard-reads.js");
      registerInventoryDashboardReads();
      // Food moved into the fridge or the freezer is re-dated by its cold shelf
      // life, and by the warm one when it comes out (cold-redate.ts).
      const { registerColdRedate } = await import("./cold-redate.js");
      registerColdRedate();
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
