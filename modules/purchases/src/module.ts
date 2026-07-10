// Purchases — second-party Cobblr connector built specifically to
// support data migration. Orders + order_items, with polymorphic
// "consumed by" pointers so finished items can be attributed to
// printers/mods/projects in other modules.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "purchases",
  version: "0.4.0",
  displayName: "Purchases",
  description:
    "Orders, line items, and cost rollup. Each order is a vendor purchase; line items can link to inventory parts and to whatever consumed them — printer mods, projects, anything.",
  icon: "shopping-bag",
  band: "stock",
  instanceability: "multi",

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
          { name: "unit_cost", type: "number" },
          { name: "received_at", type: "date" },
        ],
        // Line description + qty + received-at for cross-module display
        // ("3 of these were received last week"). Unit cost private.
        exposableFields: ["description", "qty", "received_at"],
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

  intents: [
    { name: "log_order", description: "Record a new vendor order" },
    { name: "mark_arrived", description: "Mark an order as arrived" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "purchases.order.created",
      "purchases.order.status_changed",
      "purchases.order.arrived",
      "purchases.order_item.received",
      "purchases.vendor.created",
    ],
    api: [],
    actions: [
      {
        // "Stock that reorders itself": wire inventory.stock.low here (the
        // contributed default below does exactly that) and a low part lands
        // as a line on a DRAFT (status:"planned") purchase order for its
        // usual vendor at its usual quantity — derived from the part's own
        // purchase history, zero per-part setup. Idempotent per open order;
        // the human approves (planned → ordered) and the existing arrival
        // wire restocks. Also user-invokable: a "Draft a purchase order"
        // button on any part.
        id: "purchases:draft-po",
        label: "Draft a purchase order",
        description:
          "Add this part to a draft (planned) purchase order for its usual vendor at its usual quantity — derived from purchase history. Skips parts already on an open order. Args (all optional): { partId, qty, vendorId }.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "purchases.draft-po",
        userInvokable: true,
      },
    ],
  },

  contributes: {
    fieldDefs: [],
    wires: [
      {
        // The homepage sentence, verbatim: "When a part runs low → draft a
        // PO to the usual vendor." Materialises when purchases is enabled;
        // fully visible + editable on /bindings like any wire.
        source_kind: "inventory:part",
        action_id: "purchases:draft-po",
        trigger_type: "event",
        trigger_event: "inventory.stock.low",
      },
    ],
  },

  subscribes: [],
});
