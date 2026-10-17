// Purchases — second-party Cobblr connector built specifically to
// support data migration. Orders + order_items, with polymorphic
// "consumed by" pointers so finished items can be attributed to
// printers/mods/projects in other modules.

import { ORDER_ITEM_RECEIVED_KEYS } from "./receive-keys.js";
import { ORDER_ITEM_RETURNED_KEYS } from "./return-keys.js";
import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "purchases",
  version: "0.18.2",
  displayName: "Purchases",
  description:
    "Orders you placed and what they cost, with each line tied to the parts it bought and what they went into.",
  icon: "shopping-bag",
  band: "stock",
  instanceability: "multi",
  // Purchases already writes ONTO inventory parts (draft-po, receipt roll-up),
  // so it declares that reach — which is also what earns it the price panel on
  // a part's own page (the manifest rejects a panel into an undeclared module).
  // core-scan joined when a receipt attached to a scan item started creating
  // this module's orders: contributing a panel into a module REQUIRES
  // declaring you operate on it, which is what keeps this list honest.
  operatesOn: ["inventory", "core-scan", "assets"],
  // Operating on inventory does not make the orders themselves a tool: a
  // grown sidebar files Purchases with the collections a person keeps.
  navKind: "collection",

  lifecycle: {
    // Past arrivals whose stock may never have been added: stamped, and the
    // recent ones put to a person (heal-unreceived-arrivals.ts).
    onBoot: async () => {
      // What it shows on the dashboard, read in its one request (#6563).
      const { registerPurchasesDashboardReads } = await import("./dashboard-reads.js");
      registerPurchasesDashboardReads();
      const { registerUnreceivedArrivalsHeal } = await import("./heal-unreceived-arrivals.js");
      registerUnreceivedArrivalsHeal();
    },
  },
  schema: {
    tablePrefix: "purchases_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  provides: {
    entityKinds: [
      {
        id: "purchases:order",
        primary: true,
        createEndpoint: "/orders",
        updateEndpoint: "/orders/{id}",
        deleteEndpoint: "/orders/{id}",
        displayName: "Order",
        displayNamePlural: "Orders",
        icon: "shopping-bag",
        profile: "vendor-order" /* digital · unique · — · schedulable · completable · durable */,
        fields: [
          { name: "vendor", type: "text", role: "title", required: false },
          { name: "order_number", type: "text", role: "summary" },
          { name: "status", type: "text" },
          { name: "ordered_at", type: "date" },
          { name: "expected_arrival", type: "date" },
          { name: "arrived_at", type: "date" },
          { name: "total_cost", type: "number" },
          { name: "shipping_cost", type: "number" },
          { name: "tracking_number", type: "text" },
          { name: "url", type: "url" },
          { name: "notes", type: "text" },
        ],
        // Cross-module readable: vendor / number / status + dates so a
        // task can show "blocked on Order #1234 from McMaster (arrived 2026-05-20)".
        // Costs + tracking + url stay private — internal procurement detail.
        exposableFields: [
          "vendor",
          "order_number",
          "status",
          "ordered_at",
          "expected_arrival",
          "arrived_at",
        ],
        detailRoute: "/purchases/{id}",
      },
      {
        // AI-CRUD: none — nested rows of their parent order (no standalone
        // routes); a standalone write would orphan the line from its order.
        id: "purchases:order_item",
        displayName: "Order item",
        displayNamePlural: "Order items",
        icon: "package",
        profile: "vendor-order" /* digital · unique · — · schedulable · completable · durable */,
        fields: [
          { name: "description", type: "text", role: "title" },
          { name: "qty", type: "number", role: "quantity" },
          { name: "unit_cost", type: "number", aggregate: "per_unit" },
          { name: "received_at", type: "date" },
        ],
        // Line description + qty + received-at for cross-module display
        // ("3 of these were received last week"). Unit cost private.
        exposableFields: ["description", "qty", "received_at"],
        // The module's own full-fat list (costs included, own role gating) —
        // `?part_id=` is a part's purchase history, `?order_id=` an order's
        // lines. The projected /entities/:kind list deliberately can't carry
        // unit_cost, so price-aware readers come through here.
        listEndpoint: "/items",
      },
      {
        id: "purchases:vendor",
        createEndpoint: "/vendors",
        updateEndpoint: "/vendors/{id}",
        deleteEndpoint: "/vendors/{id}",
        displayName: "Vendor",
        displayNamePlural: "Vendors",
        icon: "store",
        profile: "digital-record",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "website", type: "url" },
          { name: "account_number", type: "text" },
          { name: "contact", type: "text" },
          { name: "lead_time_days", type: "number" },
          { name: "notes", type: "text" },
        ],
        // Name + website are safe to show cross-module ("ordered from McMaster");
        // account number / contact stay private procurement detail.
        exposableFields: ["name", "website"],
        detailRoute: "/purchases/vendors/{id}",
      },
    ],
  },

  dependencies: [],

  exposes: {
    // What each event carries, for the wires that read it (receive.ts is
    // the one emitter of order_item.received).
    eventPayloads: {
      "purchases.order_item.received": [...ORDER_ITEM_RECEIVED_KEYS],
      "purchases.order_item.returned": [...ORDER_ITEM_RETURNED_KEYS],
      "purchases.order_item.unreceived": [...ORDER_ITEM_RECEIVED_KEYS],
    },
    // The KINDS of workspace notification this module sends, so the
    // workspace can say who each kind is for (Configuration > Who gets told).
    notifications: [
      { eventType: "purchases.order.due", label: "An order that should have arrived", description: "A purchase order past its expected arrival, with a Yes it turned up button." },
      { eventType: "purchases.receipts.unconfirmed", label: "Orders to check", description: "Once, when orders marked arrived before a fix may not have added their stock, with a link to settle each line." },
      { eventType: "purchases.order.return", label: "A return moved", description: "A store's own email said a return on one of your orders was started, dropped off, received, or refunded." },
    ],
    events: [
      "purchases.order.created",
      // A return step, from the order page, the assistant or the store's
      // email: requested, dropped off, received, refunded, cancelled.
      "purchases.order.return_recorded",
      // A returned line left the shelf (delta < 0), or an undo put it back.
      "purchases.order_item.returned",
      "purchases.order.status_changed",
      "purchases.order.arrived",
      "purchases.order.shipment_recorded",
      "purchases.order_item.received",
      // A line's receive taken back (delta < 0): a shipping notice proved an
      // order its receipt had filed as arrived was still on its way.
      "purchases.order_item.unreceived",
      "purchases.vendor.created",
    ],
    actions: [
      {
        id: "purchases:start-return", group: "buy", label: "Start a return", examples: ["return two of those", "I'm sending this back"],
        runBy: "member",
        description: "Start a return on an order that arrived: which line (line_id) or item, how many (qty, default 1) and why. One open return per line; a second start on the same line answers with the open one. The stock comes off the shelf when the store has it, the refund off the order's spend when it is refunded.",
        appliesTo: { kinds: ["purchases:order"] }, invokeHandler: "purchases.start-return", userInvokable: true, undoable: true,
        argsSchema: {
          order_id: { label: "Which order, defaults to the record this ran on", type: "text" },
          line_id: { label: "Which line of the order", type: "text" },
          item: { label: "The item, in words, when there is no line id", type: "text" },
          qty: { label: "How many", type: "number" },
          reason: { label: "Why it is going back", type: "text" },
        },
      },
      {
        // UI-SCREEN: /purchases/:id (the stage pills on each return)
        id: "purchases:advance-return", group: "buy", label: "Move a return along", examples: ["I dropped the return off", "the refund came through"],
        runBy: "member",
        description: "Move a return to its next stage: dropped_off, received (its count comes off the shelf, once), refunded (with refund_amount, default the line's cost; it comes off the order's spend once) or cancelled (only before the store has it). Stages only move forward.",
        scope: "workspace" as const, invokeHandler: "purchases.advance-return", userInvokable: false, undoable: true,
        argsSchema: {
          return_id: { label: "Which return", type: "text", required: true },
          stage: { label: "dropped_off, received, refunded or cancelled", type: "text", required: true },
          refund_amount: { label: "The refund, when refunded", type: "number" },
          revert: { label: "Undo only: move back to this stage", type: "boolean" },
        },
      },
      {
        // UI-SCREEN: /purchases/:id (Add a parcel, and a line's "Shipped in" chip)
        id: "purchases:add-shipment", group: "buy", label: "Add a parcel", examples: ["the black spool shipped, tracking TBA335321582286", "add tracking for part of this order"],
        runBy: "member",
        description: "Record one parcel of an order: its tracking number, and which lines are in it, by line_ids or by items (the store's words for what is in the box, matched to the order's lines). A parcel that carries every line still to come goes on the order itself. The same number twice updates the parcel.",
        appliesTo: { kinds: ["purchases:order"] }, invokeHandler: "purchases.add-shipment", userInvokable: true,
        argsSchema: {
          order_id: { label: "Which order, defaults to the record this ran on", type: "text" },
          tracking_number: { label: "The parcel's tracking number", type: "text", required: true },
          line_ids: { label: "The lines in this parcel", type: "text" },
          items: { label: "What is in the box, in the store's words (a list)", type: "json" },
          expected_arrival: { label: "When it is due (YYYY-MM-DD)", type: "text" },
        },
      },
      {
        id: "purchases:plan-order", group: "buy", label: "Plan an order", examples: ["plan an order for these parts", "track this fabrication order"],
        runBy: "member",
        description: "Create a planned purchase with lines, expected arrival, tracking and an optional source file. request_key makes retries safe. add_to_stock is false for scanned component receiving and true for blank board stock. No supplier order is submitted.",
        scope: "workspace" as const, invokeHandler: "purchases.plan-order", userInvokable: true,
        argsSchema: {
          request_key: { label: "Stable request key", type: "text", required: true }, vendor: { label: "Vendor", type: "text", required: true },
          lines: { label: "Order lines with description, qty and optional part_id", type: "json", required: true },
          add_to_stock: { label: "Add stock on arrival", type: "boolean", required: true },
          expected_arrival: { label: "Expected date", type: "text" }, tracking_number: { label: "Tracking number", type: "text" },
          source_file_id: { label: "Uploaded source file", type: "text" }, notes: { label: "Notes", type: "text" },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "buy",
        id: "purchases:remove-line",
        runBy: "member",
        internal: true,
        label: "Remove an order line",
        description: "Internal, the inverse of adding a line to a purchase order: removes it again. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "purchases.remove-line",
        argsSchema: {
          line_id: { label: "The line's id", type: "text" },
        },
      },
      {
        group: "buy",
        id: "purchases:add-line",
        runBy: "member",
        examples: ["add another line to that order", "put two more on the order"],
        undoable: true,
        label: "Add a line to this order",
        description:
          "Put another line on an order that already exists. Pass `qty` and either `description` (free text) or what it bought: `part_id` for a part you already track, or `for_kind` + `for_id` for any record (a printer, an asset), optionally `unit_cost`. A line that names what it bought links it to the order and fills its Acquired from / Acquired on / Paid from the order, never over a value someone typed. Removing a line has no action on purpose: an order is a financial record, so deleting from it is done in the app.",
        icon: "plus",
        appliesTo: { kinds: ["purchases:order"] },
        invokeHandler: "purchases.add-line",
        argsSchema: {
          qty: { label: "How many", type: "number", required: true },
          description: { label: "What it is", type: "text" },
          part_id: { label: "Id of a tracked part (optional)", type: "text" },
          for_kind: { label: "Kind of the record it bought (optional)", type: "text" },
          for_id: { label: "Id of the record it bought (optional)", type: "text" },
          unit_cost: { label: "Cost each (optional)", type: "number" },
          add_to_stock: { label: "On an order that already arrived, add this line to stock (default: the order's choice, normally yes)", type: "boolean" },
        },
      },
      {
        // NO-PHRASING: nobody asks for this; it is what attaching paperwork to a record (core-scan:attach-paperwork) records the purchase with.
        // UI-REACH: plumbing for the paperwork door, which every screen reaches through core-scan's record Files and inbox
        group: "buy",
        id: "purchases:record-paperwork",
        runBy: "member",
        label: "Record the purchase a document shows",
        description:
          "Record a purchase from a document put on a record (a bill of sale on a car): the order with every line as the paper printed it, each marked as a charge or an add-on where it is one, and the line the paper is about claimed for that record, which fills its Paid, Purchased at and Bought from. Used by the paperwork door; to attach a document to a record ask for core-scan:attach-paperwork. Args: { vendor?, ordered_at?, order_ref?, total?, currency?, source_file_id?, lines, claim? }.",
        icon: "receipt",
        scope: "workspace" as const,
        invokeHandler: "purchases.record-paperwork",
        userInvokable: false,
        argsSchema: {
          vendor: { label: "Who sold it", type: "text" },
          ordered_at: { label: "Date of the sale", type: "date" },
          order_ref: { label: "Order or invoice number", type: "text" },
          total: { label: "Total", type: "number" },
          currency: { label: "Currency (ISO code)", type: "text" },
          source_file_id: { label: "The document's file", type: "text" },
          lines: { label: "Every line: description, qty, unit_cost, line_amount, kind", type: "json", required: true },
          claim: { label: "Which line is the record's: index, kind, id", type: "json" },
        },
      },
      {
        group: "buy",
        id: "purchases:edit-line",
        runBy: "member",
        examples: ["that line was 5, not 3", "the screws were 12 cents each"],
        undoable: true,
        label: "Correct a line on this order",
        description:
          "Change one line of an order: `line_id`, and any of `description`, `qty`, `unit_cost`. A line whose stock was already added keeps its count; correct the item's own count instead, so its history says why.",
        icon: "pencil",
        appliesTo: { kinds: ["purchases:order"] },
        invokeHandler: "purchases.edit-line",
        argsSchema: {
          line_id: { label: "Which line", type: "text", required: true },
          description: { label: "What it is", type: "text" },
          qty: { label: "How many", type: "number" },
          unit_cost: { label: "Cost each", type: "number" },
        },
      },
      {
        // "Stock that reorders itself": wire inventory.stock.low here (the
        // contributed default below does exactly that) and a low part lands
        // as a line on a DRAFT (status:"planned") purchase order for its
        // usual vendor at its usual quantity — derived from the part's own
        // purchase history, zero per-part setup. Idempotent per open order;
        // the human approves (planned → ordered) and the existing arrival
        // wire restocks. Also user-invokable: a "Draft a purchase order"
        // button on any part.
        group: "buy",
        id: "purchases:draft-po",
        runBy: "member",
        examples: ["order more of these", "put that on a purchase order"],
        undoable: true,
        label: "Draft a purchase order",
        description:
          "Add this part to a draft (planned) purchase order for its usual vendor at its usual quantity: derived from purchase history. Skips parts already on an open order. Args (all optional): { partId, qty, vendorId }.",
        appliesTo: { kinds: ["inventory:part"] },
        // A purchase order re-buys a COUNT of something; it is a stock verb.
        // Without a face it sat on every inventory record, and a Home Inventory
        // kettle led with "Draft a purchase order" beside Opened and Threw it
        // out (#2849). A shelf of copies (stock face) still gets it.
        face: "stock",
        invokeHandler: "purchases.draft-po",
        argsSchema: {
          partId: { label: "Which part, defaults to the record this ran on", type: "text" },
          qty: { label: "How many to order, defaults to the usual quantity", type: "number" },
          vendorId: { label: "Which vendor, defaults to the usual one", type: "text" },
        },
        userInvokable: true,
      },
      {
        // The answer to "did it turn up?" — one tap on the order the arrival
        // sweep asked about. Sets status to arrived (which emits the arrival
        // and its per-line received events, so stock bumps), stamps today, and
        // no-ops when the order is already arrived so a stale prompt answered
        // twice cannot double-count.
        group: "buy",
        id: "purchases:mark-arrived",
        runBy: "member",
        examples: ["that order turned up", "the parcel arrived"],
        label: "Mark arrived",
        description:
          "Record that a purchase order turned up: sets its status to arrived, stamps the arrival date, and releases the stock-receipt events for every line mapped to a part. With shipmentId, only that parcel's lines are received, and the order arrives when nothing else on it is still to come. Does nothing if the order is already arrived. Args (all optional): { orderId, shipmentId, arrivedOn }.",
        appliesTo: { kinds: ["purchases:order"] },
        invokeHandler: "purchases.mark-arrived",
        argsSchema: {
          orderId: { label: "Which order, defaults to the record this ran on", type: "text" },
          shipmentId: { label: "One parcel of the order: only its lines arrived", type: "text" },
          arrivedOn: { label: "The date it arrived, defaults to today", type: "text" },
          add_to_stock: { label: "Add its lines to stock (default yes; no for a past purchase whose stock is already counted)", type: "boolean" },
        },
        userInvokable: true,
      },
    ],
  },

  contributes: {
    fieldDefs: [],
    // What you paid for this thing, last time and every time before — on the
    // thing's own page, because that's where the question gets asked. Only
    // renders where purchases is enabled; the part page names no contributor.
    panels: [
      {
        id: "purchases:price-history",
        // About what stock cost; nothing to say on a catalog.
        appliesTo: { traits: ["fungible"] },
        face: "stock",
        surface: "entity-detail-panel" as const,
        target: "inventory:part",
        title: "Price history",
      },
      // Still on its way (#5351): a thing you bought says so on its own page
      // ("On its way: Amazon Logistics TBA…, expected Oct 11", or "Not shipped
      // yet") until it arrives, and so does the receipt's row in the scan
      // inbox, before it is any record. Nothing at all once it is here.
      {
        id: "purchases:on-its-way",
        surface: "entity-detail-panel" as const,
        target: "inventory:part",
        title: "On its way",
        placement: "summary",
      },
      {
        id: "purchases:on-its-way",
        surface: "entity-detail-panel" as const,
        target: "assets:asset",
        title: "On its way",
        placement: "summary",
      },
      {
        id: "purchases:on-its-way",
        surface: "entity-detail-panel" as const,
        target: "core-scan:item",
        title: "On its way",
        placement: "summary",
      },
      // The rest of the receipt. Attaching a receipt to one item records every
      // line on the order, and the others are just sitting there unclaimed —
      // this is what says so, on the card, where the decision belongs. The
      // scan card names no contributor: it renders whatever declared into it
      // and passes its own receipt group id as a hint.
      {
        id: "purchases:receipt-lines",
        surface: "entity-detail-panel" as const,
        target: "core-scan:item",
        title: "From this receipt",
      },
    ],
    wires: [
      {
        // The homepage sentence, verbatim: "When a part runs low → draft a
        // PO to the usual vendor." Materialises when purchases is enabled;
        // fully visible + editable on /wires like any wire.
        source_kind: "inventory:part",
        action_id: "purchases:draft-po",
        trigger_type: "event",
        trigger_event: "inventory.stock.low",
      },
    ],
  },

  subscribes: [],
});
