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
  version: "0.2.4",
  displayName: "Lists",
  description:
    "Lightweight checklists: a list + check-off-able items. Shopping lists, to-do, packing. Other modules can auto-add items via a wire (e.g. 'running low' → shopping list).",
  icon: "list-checks",
  band: "stock",
  autoEnable: false,

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
    events: [
      "lists.list.created",
      "lists.list.deleted",
      "lists.item.added",
      "lists.item.checked",
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
    api: [],
    actions: [
      {
        id: "lists:clear-done",
        examples: ["clear the ticked ones", "tidy up this list"],
        label: "Clear done items",
        description:
          "Remove every ticked-off item from this list, leaving the unticked ones. Nothing else on the list changes. Irreversible, so it always confirms.",
        icon: "eraser",
        appliesTo: { kinds: ["lists:list"] },
        invokeHandler: "lists.clear-done",
      },
      {
        id: "lists:add-item",
        examples: ["put milk on the shopping list", "add that to my list"],
        undoable: true,
        label: "Add to a list",
        description:
          "Append an item to a list. Wire it to an event (e.g. inventory.stock.low) to auto-build a shopping list. Dedupes by title within the list (won't pile up duplicates).",
        // DELIBERATELY universal: anything — physical or digital — can be put
        // on a list. The one honest any:true among the entity-bound actions.
        appliesTo: { any: true },
        invokeHandler: "lists.add-item",
        argsSchema: {
          title: { label: "What to add, defaults to the source record's title", type: "text" },
          listId: { label: "Which list, by id", type: "text" },
          listTitle: { label: "Which list, by name; created if it does not exist yet", type: "text" },
          qty: { label: "How many", type: "number" },
          note: { label: "Optional note on the item", type: "text" },
        },
        userInvokable: false,
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
    },
    onShutdown: async () => {
      const { stopExpirySweeper } = await import("./expiry-sweeper.js");
      stopExpirySweeper();
    },
  },
});
