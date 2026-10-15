// lists — a lightweight CHECKLIST primitive: a List with check-off-able
// items. The "list of intents" shape that inventory (durable stock) can't model
// cleanly — first use is a grocery shopping list, but it equally serves to-do,
// packing, and wishlist flows.
//
// Two entity kinds: a durable `list` and an ephemeral `item` (checked/unchecked).
// It EMITS item lifecycle events and EXPOSES an `add-item` action so other
// modules can auto-append via a wire (e.g. inventory.stock.low → add to the
// shopping list). See docs/product/home-life-use-cases.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "lists",
  version: "0.1.22",
  displayName: "Lists",
  description:
    "Simple checklists for shopping, packing or to-dos, which can fill themselves when something runs low.",
  icon: "list-checks",
  band: "stock",
  autoEnable: false,
  // A list is something you DO (check things off), not a collection you keep,
  // so a grown sidebar files it with the tools.
  navKind: "tool",

  schema: {
    tablePrefix: "lists_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  provides: {
    entityKinds: [
      {
        id: "lists:list",
        createEndpoint: "/lists",
        updateEndpoint: "/lists/{id}",
        deleteEndpoint: "/lists/{id}",
        displayName: "List",
        displayNamePlural: "Lists",
        icon: "list-checks",
        profile: "digital-record",
        fields: [
          { name: "title", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["title", "description"],
        detailRoute: "/lists/{id}",
        getEndpoint: "/lists/{id}",
      },
      {
        // sidecar-exempt: a list item is a line inside its list, never opened on
        // its own — the list is where the conversation belongs
        id: "lists:item",
        createEndpoint: "/items",
        updateEndpoint: "/items/{id}",
        deleteEndpoint: "/items/{id}",
        displayName: "List item",
        displayNamePlural: "Items",
        icon: "check",
        // Ephemeral: a checked-off intent is throwaway, not a durable record.
        profile: "auto-pruning-record",
        fields: [
          { name: "title", type: "text", role: "title", required: true },
          { name: "note", type: "text", role: "summary" },
          { name: "qty", type: "text", role: "quantity" },
          { name: "checked", type: "boolean" },
          { name: "checked_at", type: "date" },
          { name: "list_id", type: "text", required: true },
          { name: "metadata", type: "object" },
        ],
        exposableFields: ["title", "note", "qty", "checked", "checked_at", "list_id"],
        detailRoute: "/lists/items/{id}",
        getEndpoint: "/items/{id}",
      },
    ],
  },

  exposes: {
    // What a check-off carries. The item's record rides under its kind's own
    // id key (partId for a part), with sourceRef beside it.
    eventPayloads: {
      "lists.item.checked": ["listId", "itemId", "checked", "partId", "sourceRef", "quantity", "restocks", "actorId", "once", "reversible", "sourceKind", "sourceId"],
      "lists.item.unchecked": ["listId", "itemId", "partId", "sourceRef", "actorId"],
    },
    // The KINDS of workspace notification this module sends, so the
    // workspace can say who each kind is for (Configuration > Who gets told).
    notifications: [
      { eventType: "lists.expiring", label: "Things to use up", description: "Food and other dated items that are about to expire, once a day, with Used up and Threw out buttons." },
    ],
    events: [
      "lists.list.created",
      "lists.list.deleted",
      "lists.item.added",
      "lists.item.checked",
      // A tick taken back: what the tick did to the line's record is undone.
      "lists.item.unchecked",
      // Someone said "I'm getting this" (or took it back) on a shared list.
      "lists.item.claimed",
      "lists.item.removed",
      // Fired by the expiry sweeper per inventory part expiring soon — wire it
      // to lists:add-item to auto-restock the shopping list.
      // Approaching its date. Fires from EXPIRY_SOON_DAYS out, so it is true of
      // anything whose whole shelf life is shorter than that window from the
      // moment it is entered. Safe to hang a "buy a replacement" on; never hang
      // anything that assumes the food is gone.
      "lists.item.expiring",
      // The date has actually passed. Still not "was thrown away" - only a
      // person can say that.
      "lists.item.expired",
    ],
    actions: [
      {
        group: "buy",
        id: "lists:clear-done",
        runBy: "member",
        examples: ["clear the ticked ones", "tidy up this list"],
        label: "Clear done items",
        description:
          "Remove every ticked-off item from this list, leaving the unticked ones. Nothing else on the list changes. Irreversible, so it always confirms.",
        icon: "eraser",
        appliesTo: { kinds: ["lists:list"] },
        invokeHandler: "lists.clear-done",
      },
      {
        group: "buy",
        id: "lists:add-item",
        runBy: "member",
        examples: ["put milk on the shopping list", "add that to my list"],
        undoable: true,
        label: "Add to a list",
        description:
          "Append an item to a list: a record (its title) or just words (\"milk\"), with no record needed. Name the list by id or by name (made if it does not exist). A person adding a record without naming a list gets the list that record last went on, or, the first time, `needs_list` with the lists to choose from; a wire with no list still uses \"Shopping list\". Wire it to an event (e.g. inventory.stock.low) to auto-build a shopping list. Dedupes by title within the list.",
        // DELIBERATELY universal: anything — physical or digital — can be put
        // on a list. The one honest any:true among the entity-bound actions.
        appliesTo: { any: true },
        // And nothing at all: "put milk on the shopping list" names no record.
        // Required a record, this action's own first example could not run,
        // and a stranger asking it got an empty "Shopping" list and no milk
        // (a walk on 2026-09-22, #3255).
        recordOptional: true,
        invokeHandler: "lists.add-item",
        argsSchema: {
          title: { label: "What to add, defaults to the source record's title", type: "text" },
          listId: { label: "Which list, by id", type: "text" },
          listTitle: { label: "Which list, by name; created if it does not exist yet", type: "text" },
          qty: { label: "How many", type: "number" },
          note: { label: "Optional note on the item", type: "text" },
          restocks: { label: "Checking it off adds it back to the record's stock", type: "boolean" },
        },
        userInvokable: false,
      },
      {
        // NO-PHRASING: a module taking back a line it put on a list itself
        group: "buy",
        id: "lists:withdraw-item",
        runBy: "member",
        internal: true,
        label: "Take back a line a module added",
        description:
          "Internal: remove an item another module added to a list (a pattern's missing yarn, once it is no longer missing). Only an item still unticked is removed; one somebody already ticked off stays.",
        icon: "eraser",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "lists.withdraw-item",
        argsSchema: {
          item_id: { label: "The item's id", type: "text" },
        },
      },
      // ACTION-TEMPLATE: internal and never phrased; inventory's listener calls it and api/tests/a-shopping-line-typed-by-hand-restocks-the-item-it-names.test.ts proves it
      {
        // NO-PHRASING: a module linking a line to the record its title names
        group: "buy",
        id: "lists:link-item",
        runBy: "member",
        internal: true,
        label: "Link a typed line to the record it names",
        description:
          "Internal: point an unticked line that has no record behind it at the record its title names, so ticking it restocks that record. A line that already has a record is left alone.",
        icon: "link",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "lists.link-item",
        argsSchema: {
          item_id: { label: "The item's id", type: "text" },
          kind: { label: "The record's kind", type: "text" },
          id: { label: "The record's id", type: "text" },
        },
      },
    ],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      const { startExpirySweeper } = await import("./expiry-sweeper.js");
      startExpirySweeper();
      const { registerExpiryCalendarSource } = await import("./calendar-source.js");
      registerExpiryCalendarSource();
      const { registerRecoveredStock } = await import("./recovered-stock.js");
      registerRecoveredStock();
    },
    onShutdown: async () => {
      const { stopExpirySweeper } = await import("./expiry-sweeper.js");
      stopExpirySweeper();
    },
  },
});
