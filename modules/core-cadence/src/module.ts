import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-cadence",
  version: "0.1.0",
  displayName: "Cadence",
  description:
    "Learns how fast you go through a consumable and predicts when you'll run out, so a reorder can be suggested before you notice. Generic: it reads a kind's quantity field role, so the same engine serves groceries, filament, coffee and medications. Exposes signals other modules surface; it has no page of its own.",
  icon: "repeat",
  band: "stock",
  // Opt-in, not ambient: a workspace that doesn't track consumables shouldn't
  // pay for an event ledger it never writes to.
  autoEnable: false,

  schema: {
    tablePrefix: "core_cadence_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  exposes: {
    // Consumers wire off these rather than importing the module (isolation).
    events: [
      "core-cadence.reorder.due",
      "core-cadence.overbuy.detected",
      "core-cadence.buy-less.suggested",
    ],
    api: ["record", "state"],
    actions: [
      {
        // Wire/AI-invokable so a receipt import or a list check-off can record a
        // purchase without knowing this module's HTTP shape. NOT userInvokable:
        // people record consumption by using the app, not by filing ledger rows.
        id: "core-cadence:record-event",
        label: "Record a stock event",
        description:
          "Append a quantity change (purchase / consume / adjust / discard) for a record, so its consumption cadence stays current. Args: { event_type, qty_delta, context?, source?, unit_price?, occurred_at? }.",
        // THE genericity guarantee, enforced by the platform rather than by
        // convention: cadence applies to anything that declares a quantity, so
        // groceries, filament, coffee and medications all qualify and nothing
        // here ever names a use case.
        appliesTo: { hasFieldRole: "quantity" },
        invokeHandler: "core-cadence.record-event",
        userInvokable: false,
      },
    ],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      const { startCadenceSweeper } = await import("./sweeper.js");
      startCadenceSweeper();
    },
  },
});
