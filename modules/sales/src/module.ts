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
  version: "0.4.0",
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
        deleteBy: "member",
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
        deleteBy: "member",
        displayName: "Sales order",
        displayNamePlural: "Sales orders",
        icon: "shopping-cart",
        profile: "vendor-order",
        fields: [
          { name: "customer_name", type: "text", role: "title" },
          { name: "order_number", type: "text", role: "summary" },
          { name: "status", type: "text" },
          { name: "paid", type: "boolean" },
          { name: "paid_at", type: "date" },
          { name: "order_date", type: "date" },
          { name: "due_date", type: "date" },
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
        exposableFields: ["customer_name", "order_number", "status", "paid", "order_date", "due_date", "fulfilled_at", "carrier", "tracking_number", "shipped_at", "metadata"],
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
    notifications: [
      { eventType: "sales.order.closed", label: "Delivered orders closed", description: "A paid, fully fulfilled order closed after delivery, with Undo." },
      { eventType: "sales.order.due", label: "Orders due", description: "An open order due tomorrow, or late, once for each due date." },
    ],
    actions: [
      {
        // NO-PHRASING: offered by the notification and order sheet after an automatic close
        group: "more",
        id: "sales:undo-delivery-close",
        changes: "records",
        runBy: "member",
        internal: true,
        label: "Undo delivery close", icon: "undo",
        description: "Reopen an order closed automatically after delivery. Leaves it shipped and prevents another automatic close.",
        invokeHandler: "sales.undo-delivery-close", userInvokable: false, scope: "workspace",
        argsSchema: { order_id: { label: "Order id", type: "text", required: true } },
      },
      {
        // WORKSPACE-scoped by its line's id, and also the way back for add-line.
        group: "more",
        // UI-SCREEN: /sales
        id: "sales:remove-line",
        changes: "records",
        runBy: "member",
        examples: ["take the third line off that order", "remove the gift wrap line"],
        label: "Remove an order line",
        description:
          "Take a line off a sales order, by the line's id (get_record on the order lists them). Not undoable: an order is a financial record, so it always asks first.",
        icon: "trash-2",
        scope: "workspace" as const,
        invokeHandler: "sales.remove-line",
        argsSchema: {
          line_id: { label: "The line's id", type: "text", required: true },
        },
      },
      {
        group: "more",
        id: "sales:add-line",
        changes: "records",
        runBy: "member",
        examples: ["add a line to that order", "they want two more"],
        undoable: true,
        label: "Add a line to this order",
        description:
          "Put another line on a sales order that already exists. Pass `qty` and either `description` or `part_id` for a part you track, optionally `unit_price`. Changing or removing a line has its own action, which always asks first.",
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
        changes: "records",
        runBy: "member",
        examples: ["cancel that order", "they cancelled"],
        undoable: true,
        label: "Cancel order",
        description:
          "Cancel a sales order. One that has not shipped puts back on the shelf what Fulfill took from it. One that has shipped needs returned: true (it came back, so its stock goes back) or false (cancel it, stock stays as it is); without it the answer asks. Undo takes the stock again; if any is missing, the order stays open for the rest. Args: { returned? }.",
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
        changes: "records",
        runBy: "member",
        internal: true,
        label: "Reinstate a cancelled order",
        description: "Internal, the inverse of cancelling a sales order: takes again what the cancel put back, restoring its former status only when its stock is covered. Missing stock leaves the order open for fulfilment. Runs from Undo; not for direct use.",
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
        id: "sales:return-line",
        changes: "records",
        runBy: "member",
        examples: ["a customer sent a mug back", "refund that order", "record a refund of $12 on the order"],
        undoable: true,
        label: "Record a return or refund",
        description:
          "A customer sent something back and/or was refunded. Pass line_id and qty to put returned goods back on the shelf (only what was fulfilled, once), and refund_amount to record money refunded: never more than was paid, nothing on an unpaid order. Either may be given alone (a refund for a cancelled paid order has no goods). It only records the refund: nothing here moves real money.",
        icon: "undo",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.return-line",
        userInvokable: true,
        argsSchema: {
          line_id: { label: "The line the goods came from", type: "text" },
          qty: { label: "How many came back", type: "number" },
          refund_amount: { label: "How much was refunded", type: "number" },
          reason: { label: "Why (optional)", type: "text" },
        },
      },
      {
        // NO-PHRASING: the way back for a return, run only from Undo
        group: "more",
        id: "sales:undo-return",
        changes: "records",
        runBy: "member",
        internal: true,
        examples: ["undo that return"],
        label: "Take a return back",
        description: "Internal, the inverse of recording a return or refund: takes the stock out again only if all of it is still on the shelf, and says no otherwise.",
        icon: "undo",
        appliesTo: { kinds: ["sales:order"] },
        userInvokable: false,
        invokeHandler: "sales.undo-return",
        argsSchema: {
          return_id: { label: "The return to take back", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:record-payment",
        changes: "records",
        runBy: "member",
        examples: ["Ada paid $20 cash on that order", "record a card payment of $15", "she paid half now"],
        undoable: true,
        label: "Record a payment",
        description:
          "A customer paid some or all of an order. Pass amount (never more than is still owed), method (cash, card or other; free text allowed) and paid_on (a day, default today). Several payments on one order are a part payment or a split between cash and card. Paid and owed come from these payments. It only records what was received: nothing here moves real money.",
        icon: "check",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.record-payment",
        userInvokable: true,
        argsSchema: {
          amount: { label: "How much was paid", type: "number" },
          method: { label: "How (cash, card, other)", type: "text" },
          paid_on: { label: "The day it was paid (optional)", type: "text" },
        },
      },
      {
        // NO-PHRASING: the way back for a payment, run only from Undo
        group: "more",
        id: "sales:undo-payment",
        changes: "records",
        runBy: "member",
        internal: true,
        examples: ["undo that payment"],
        label: "Take a payment back",
        description: "Internal, the inverse of recording a payment: removes it, and says no when a refund was recorded against what it paid.",
        icon: "undo",
        appliesTo: { kinds: ["sales:order"] },
        userInvokable: false,
        invokeHandler: "sales.undo-payment",
        argsSchema: {
          payment_id: { label: "The payment to take back", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:hold-order",
        changes: "records",
        runBy: "member",
        examples: ["hold those candles for Ada", "set that order aside until Saturday", "put a hold on the mug for her"],
        undoable: true,
        label: "Hold an order's stock",
        description:
          "Set aside the stock of a draft order's lines for the customer. Optionally pass until (a day) and the hold lets go by itself then. The item shows as held for the customer and is never sold twice: another order is told only what is free. The hold also lets go when the order is cancelled or fulfilled. Only a draft order holds.",
        icon: "bookmark",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.hold-order",
        userInvokable: true,
        argsSchema: {
          until: { label: "The day the hold lets go (optional)", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:release-hold",
        changes: "records",
        runBy: "member",
        examples: ["let go of that hold", "release the stock I held for Ada"],
        label: "Release an order's hold",
        description: "Let go of the stock a draft order holds, so it is free for other orders again.",
        icon: "unlock",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.release-hold",
        userInvokable: true,
        argsSchema: {},
      },
      {
        group: "more",
        id: "sales:fulfill-order",
        changes: "records",
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
        changes: "records",
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
        changes: "records",
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
        changes: "records",
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
        // UI-SCREEN: /sales (New order creates through the orders route rather than this import action)
        id: "sales:create-order",
        changes: "records",
        runBy: "member",
        examples: ["a new order came in", "record an order from the shop"],
        label: "Create order",
        description:
          "Create a sales order programmatically (e.g. importing an order from a connected store). Optionally upserts the customer by email and adds line items. Args: { order_number?, status?, order_date?, due_date?, notes?, metadata?, customer?: {name,email,phone,address}, items?: [{part_id?, description?, qty, unit_price?, metadata?}] }.",
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
          due_date: { label: "When the customer wants it, ISO date", type: "text" },
          notes: { label: "Notes on the order (optional)", type: "text" },
          metadata: { label: "Any extra fields to store on the order", type: "json" },
        },
        userInvokable: false,
      },
      {
        group: "more",
        id: "sales:prepare-document",
        changes: "records",
        runBy: "member",
        examples: ["Make a quote for this order", "Issue an invoice for this order"],
        label: "Prepare a quote or invoice",
        description: "Create a quote or issue a numbered invoice from this order, with a saved copy of its lines and totals.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.prepare-document",
        argsSchema: {
          kind: { label: "quote or invoice", type: "text", required: true },
          shop_name: { label: "Shop name", type: "text", required: true },
          deadline: { label: "Due or valid-until date (YYYY-MM-DD)", type: "text" },
          tax_rate: { label: "Tax percentage", type: "number" },
          logo_file_id: { label: "Optional PNG or JPEG logo file", type: "text" },
        },
      },
      {
        group: "more",
        id: "sales:send-document",
        changes: "records",
        userInvokable: false,
        undoable: false,
        effect: "spends",
        // ADMIN-ONLY: emailing a customer requires the owner; the handler checks the exact role.
        runBy: "admin",
        examples: ["Send this invoice to the customer", "Email the quote"],
        label: "Email a quote or invoice",
        description: "Email the saved quote or invoice PDF to this order's customer after the owner confirms the recipient and document.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.send-document",
        argsSchema: {
          kind: { label: "quote or invoice", type: "text", required: true },
          version: { label: "Saved document revision", type: "text", required: true },
          to: { label: "Customer email to confirm", type: "text", required: true },
        },
      },
      {
        group: "more",
        id: "sales:change-line",
        changes: "records",
        runBy: "member",
        examples: ["make that two instead of three"],
        label: "Change an order line",
        description: "Change a line on this sales order: how many, the price each, or what it says. Always asks first, since an order is a financial record.",
        appliesTo: { kinds: ["sales:order"] },
        invokeHandler: "sales.change-line",
        argsSchema: {
          line: { label: "Which line (what it says, or its id)", type: "text" },
          qty: { label: "How many", type: "number" },
          unit_price: { label: "Price each", type: "number" },
          description: { label: "What it says", type: "text" },
        },
      },
    ],
  },

  subscribes: [],
});
