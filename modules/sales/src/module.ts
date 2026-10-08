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
  version: "0.1.27",
  displayName: "Sales",
  description:
    "Customers and the orders they place; fulfilling an order takes what you sold out of stock.",
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
        // sidecar-exempt: a customer is chosen from a picker on an order; there is
        // no customer detail view to hang a conversation on yet
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
          { name: "paid", type: "boolean" },
          { name: "order_date", type: "date" },
          { name: "fulfilled_at", type: "date" },
          { name: "carrier", type: "text" },
          { name: "tracking_number", type: "text" },
          { name: "shipped_at", type: "date" },
          { name: "shipping_address", type: "text" },
          { name: "notes", type: "text" },
          // A bundle's custom fields, as on every other instance-backed kind.
          { name: "metadata", type: "object" },
        ],
        // Customer + number + status + dates for cross-module display
        // ("blocked until sales order #12 ships"). Address / notes stay private.
        // A bundle's own fields ride in `metadata`, readable like a part's, so
        // a label or view naming one prints its value (#3591).
        exposableFields: ["customer_name", "order_number", "status", "paid", "order_date", "fulfilled_at", "carrier", "tracking_number", "shipped_at", "metadata"],
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
          { name: "unit_price", type: "number", aggregate: "per_unit" },
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
      // An order went out: carrier + tracking number. Wire it to anything that
      // reacts to a shipment. The customer is emailed only by a person.
      "sales.order.shipped",
      // An order was deleted: its id, for anything that kept a copy of it.
      "sales.order.deleted",
      // A sent parcel's delivered scan, when "Follow parcels I send" is on.
      "sales.order.delivered",
    ],
    notifications: [{ eventType: "sales.order.closed", label: "Delivered orders closed", description: "A paid, fully fulfilled order closed after delivery, with Undo." }],
    actions: [
      {
        // NO-PHRASING: offered by the notification and order sheet after an automatic close
        group: "more",
        id: "sales:undo-delivery-close",
        runBy: "member",
        internal: true,
        label: "Undo delivery close", icon: "undo",
        description: "Reopen an order closed automatically after delivery. Leaves it shipped and prevents another automatic close.",
        invokeHandler: "sales.undo-delivery-close", userInvokable: false, scope: "workspace",
        argsSchema: { order_id: { label: "Order id", type: "text", required: true } },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "more",
        id: "sales:remove-line",
        runBy: "member",
        internal: true,
        label: "Remove an order line",
        description: "Internal, the inverse of adding a line to a sales order: removes it again. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "sales.remove-line",
        argsSchema: {
          line_id: { label: "The line's id", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:add-line",
        runBy: "member",
        examples: ["add a line to that order", "they want two more"],
        undoable: true,
        label: "Add a line to this order",
        description:
          "Put another line on a sales order that already exists. Pass `qty` and either `description` or `part_id` for a part you track, optionally `unit_price`. Removing a line has no action on purpose: an order is a financial record, so deleting from it is done in the app.",
        icon: "plus",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.add-line",
        argsSchema: {
          qty: { label: "How many", type: "number", required: true },
          description: { label: "What is being sold", type: "text" },
          part_id: { label: "Id of a tracked part (optional)", type: "text" },
          unit_price: { label: "Price each (optional)", type: "number" },
        },
      },
      {
        group: "more",
        id: "sales:cancel-order",
        runBy: "member",
        examples: ["cancel that order", "they cancelled"],
        undoable: true,
        label: "Cancel order",
        description:
          "Cancel a sales order. One that has not shipped puts back on the shelf what Fulfill took from it. One that has shipped needs returned: true (it came back, so its stock goes back) or false (cancel it, stock stays as it is); without it the answer asks. Undo takes the stock again and restores the status. Args: { returned? }.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.cancel-order",
        userInvokable: true,
        argsSchema: {
          returned: { label: "For an order that shipped: did it come back? (true puts its stock back)", type: "boolean" },
        },
      },
      {
        // NO-PHRASING: the way back for a cancel, run only from Undo
        group: "more",
        id: "sales:reinstate-order",
        runBy: "member",
        internal: true,
        label: "Reinstate a cancelled order",
        description: "Internal, the inverse of cancelling a sales order: restores its status and takes again what the cancel put back. Runs from Undo; not for direct use.",
        icon: "undo",
        appliesTo: { kinds: ["sales:order"] },
        userInvokable: false,
        invokeHandler: "sales.reinstate-order",
        argsSchema: {
          from: { label: "The status it had", type: "text" },
          restocked: { label: "What the cancel put back, as JSON", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:fulfill-order",
        runBy: "member",
        examples: ["that order went out", "mark it shipped"],
        label: "Fulfill order",
        description:
          "Ship a sales order from stock: take each line's inventory part out of stock (via inventory:adjust-stock) and stamp fulfilled_at. Refuses, naming what is short, when stock does not cover the order; ship: \"available\" ships what is on hand and leaves the rest of the order open. Args: { order_id, ship? }.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.fulfill-order",
        userInvokable: true,
        argsSchema: {
          order_id: { label: "Sales order id", type: "text" },
          ship: { label: "\"all\" (the default) ships the whole order or nothing; \"available\" ships what is in stock now", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:make-line",
        runBy: "member",
        examples: ["make the brackets for that order", "put 5 of those in to be made"],
        label: "Make this for the order",
        description:
          "Put a sales order line's part in to be made: a work order in Builds for the build that makes that part, made for this order, which closes itself when that many good ones are counted. With Digital Fabrication on, a new work order also starts a Make for the order (returned as makeId; the same work order put in again keeps its Make). Refuses when nothing is set up to make the part. Args: { order_id, line_id, qty }.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.make-line",
        userInvokable: true,
        argsSchema: {
          order_id: { label: "Sales order id", type: "text" },
          line_id: { label: "The order line", type: "text", required: true },
          qty: { label: "How many to make", type: "number", required: true },
        },
      },
      {
        group: "more",
        id: "sales:ship-order",
        runBy: "member",
        examples: ["that order went out with UPS", "it shipped, here is the tracking number"],
        label: "Ship order",
        description:
          "Mark a sales order shipped with its carrier and tracking number (the carrier is worked out from the number when you leave it out). An order not yet fulfilled is fulfilled first, or refused naming what is short. Never emails the customer: a person does that from the order's Ship button. Args: { order_id, tracking_number?, carrier? }.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.ship-order",
        userInvokable: true,
        argsSchema: {
          order_id: { label: "Sales order id", type: "text" },
          tracking_number: { label: "The tracking number", type: "text" },
          carrier: { label: "The carrier, if the number does not say", type: "text" },
        },
      },
      {
        // UI-REACH: inbound mail creates a draft; the Sales order sheet offers review and confirmation.
        group: "more",
        id: "sales:read-order-email",
        runBy: "member",
        examples: ["read this order email"],
        label: "Read an order email",
        description: "Read a sales order email using templates then free AI, and save a draft with the email for review. Non-orders create nothing.",
        scope: "workspace",
        invokeHandler: "sales.read-order-email",
        argsSchema: {
          subject: { label: "Email subject", type: "text", required: true },
          text: { label: "Full email body", type: "text", required: true },
          ref: { label: "Stable message reference", type: "text", required: true },
          from_email: { label: "Sender email", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:create-order",
        runBy: "member",
        examples: ["a new order came in", "record an order from the shop"],
        label: "Create order",
        description:
          "Create a sales order programmatically (e.g. importing an order from a connected store). Optionally upserts the customer by email and adds line items. Args: { order_number?, status?, order_date?, notes?, metadata?, customer?: {name,email,phone,address}, items?: [{part_id?, description?, qty, unit_price?, metadata?}] }.",
        // Creates an order; it never operates on an existing one, so it is
        // not a button on an order (#3378).
        scope: "workspace",
        invokeHandler: "sales.create-order",
        argsSchema: {
          source: { label: "Source name, stable order reference and optional URL for duplicate prevention", type: "json" },
          instance: { label: "Sales instance to receive the order", type: "text" },
          order_number: { label: "Your reference for the order, generated if you leave it out", type: "text" },
          customer: { label: "The customer: name, email, phone, address", type: "json" },
          items: { label: "The line items to order", type: "json", required: true },
          status: { label: "Order status", type: "text" },
          order_date: { label: "The date of the order, ISO date", type: "text" },
          notes: { label: "Notes on the order (optional)", type: "text" },
          metadata: { label: "Any extra fields to store on the order", type: "json" },
        },
        userInvokable: false,
      },
    ],
  },

  subscribes: [],
});
