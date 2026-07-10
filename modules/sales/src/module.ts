// sales — outbound order management: customers, sales orders, line items.
//
// The other half of the operations loop from purchases (inbound). The
// distinctive move: **fulfilling** a sales order decrements the sold parts from
// inventory stock (via the inventory:adjust-stock action, never a join) — which
// trips inventory's low-stock signal → the reorder wires. So sale → fulfil →
// decrement → reorder closes end to end. Strategy: business-models/docs/15.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "sales",
  version: "0.2.0",
  displayName: "Sales",
  description:
    "Outbound order management: customers, sales orders, and line items. Fulfilling an order decrements the sold inventory parts from stock — closing the sale → fulfil → decrement → reorder loop. For makers and small shops selling finished goods.",
  icon: "shopping-cart",
  band: "stock",
  instanceability: "multi",

  schema: {
    tablePrefix: "sales_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  provides: {
    entityKinds: [
      {
        id: "sales:customer",
        createEndpoint: "/customers",
        updateEndpoint: "/customers/{id}",
        deleteEndpoint: "/customers/{id}",
        displayName: "Customer",
        displayNamePlural: "Customers",
        icon: "user",
        profile: "digital-record",
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "email", type: "text" },
          { name: "phone", type: "text" },
          { name: "address", type: "text" },
          { name: "notes", type: "text" },
        ],
        // Name only is safe to surface cross-module; contact details stay private.
        exposableFields: ["name"],
        detailRoute: "/sales/customers/{id}",
      },
      {
        id: "sales:order",
        primary: true,
        createEndpoint: "/orders",
        updateEndpoint: "/orders/{id}",
        deleteEndpoint: "/orders/{id}",
        displayName: "Sales order",
        displayNamePlural: "Sales orders",
        icon: "shopping-cart",
        profile: "vendor-order",
        fields: [
          { name: "customer_name", type: "text", role: "title" },
          { name: "order_number", type: "text", role: "summary" },
          { name: "status", type: "text" },
          { name: "order_date", type: "date" },
          { name: "fulfilled_at", type: "date" },
          { name: "shipping_address", type: "text" },
          { name: "notes", type: "text" },
        ],
        // Customer + number + status + dates for cross-module display
        // ("blocked until sales order #12 ships"). Address / notes stay private.
        exposableFields: ["customer_name", "order_number", "status", "order_date", "fulfilled_at"],
        detailRoute: "/sales/{id}",
      },
      {
        // AI-CRUD: none — nested rows of their parent order (no standalone
        // routes); a standalone write would orphan the line from its order.
        id: "sales:order_item",
        displayName: "Sales line item",
        displayNamePlural: "Sales line items",
        icon: "package",
        profile: "vendor-order",
        fields: [
          { name: "description", type: "text", role: "title" },
          { name: "qty", type: "number", role: "quantity" },
          { name: "unit_price", type: "number" },
        ],
        exposableFields: ["description", "qty"],
      },
    ],
  },

  exposes: {
    events: [
      "sales.customer.created",
      "sales.order.created",
      "sales.order.status_changed",
      // Fired when an order is fulfilled (stock decremented). Carries order_id +
      // the decremented lines — wire it to anything that reacts to a sale.
      "sales.order.fulfilled",
    ],
    api: [],
    actions: [
      {
        id: "sales:fulfill-order",
        label: "Fulfill order",
        description:
          "Mark a sales order fulfilled: decrement each line item's inventory part from stock (via inventory:adjust-stock) and stamp fulfilled_at. Generic capability a bundle/app composes. Args: { order_id }.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.fulfill-order",
        userInvokable: true,
        argsSchema: {
          order_id: { label: "Sales order id", type: "text" },
        },
      },
      {
        id: "sales:create-order",
        label: "Create order",
        description:
          "Create a sales order programmatically (e.g. importing an order from a connected store). Optionally upserts the customer by email and adds line items. Args: { order_number?, status?, order_date?, notes?, metadata?, customer?: {name,email,phone,address}, items?: [{part_id?, description?, qty, unit_price?, metadata?}] }.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.create-order",
        userInvokable: false,
        argsSchema: {
          order_number: { label: "Order number", type: "text" },
        },
      },
    ],
  },

  subscribes: [],
});
