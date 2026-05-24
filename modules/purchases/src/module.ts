// Purchases — second-party Cobblr connector built specifically to
// support the companion app migration. Orders + order_items, with polymorphic
// "consumed by" pointers so finished items can be attributed to
// printers/mods/projects in other modules.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "purchases",
  version: "0.1.0",
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
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
