// core-recurrence — schedule-triggered wires.
//
// Q4 from docs/architecture/wires-and-bundles.md: this module
// owns the third wire trigger type. A wire with `trigger_type:
// "schedule"` and an RRULE in `trigger_schedule` fires whenever the
// RRULE's next occurrence has elapsed since the wire's last firing.
//
// Band: stock. Default-installed; users can disable to opt out of
// scheduled wires entirely (their event-triggered + user-invoked
// wires keep working).
//
// Implementation: the scheduler loop lives in api/scheduler.ts and
// is started/stopped via this module's lifecycle hooks. Uses
// platform().db.meta for the (necessarily cross-tenant) read of
// entity_action_bindings; emits via platform().events.emit for the
// fire side, which then dispatches per-tenant wires.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-recurrence",
  version: "0.2.0",
  displayName: "Recurrence",
  description:
    "Run an automation on a schedule: every Monday morning, the first of the month, whenever you set.",
  icon: "calendar",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  // The overdue sweep remembers which tier each record was told (src/overdue.ts).
  schema: {
    tablePrefix: "core_recurrence_",
    migrationsDir: "./migrations",
  },

  dependencies: [],

  api: () => import("./api/index.js"),

  // AI-REACH: no kinds/actions by design. A recurrence is a schedule attached
  // to another module's record, not a thing of its own; what it PRODUCES shows
  // up through list_calendar and the owning record's own kind.

  exposes: {
    // overdue: a record at or past its deadline, once per tier (due, late,
    // stale), with how many days and who has it. Wires decide what each earns.
    events: [
      "core-recurrence.rule.fired",
      "core-recurrence.overdue",
      "core-recurrence.overdue.due",
      "core-recurrence.overdue.late",
      "core-recurrence.overdue.stale",
    ],
    actions: [],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      const { startRecurrenceScheduler } = await import("./api/scheduler.js");
      startRecurrenceScheduler();
      const { startOverdueSweeper } = await import("./overdue.js");
      startOverdueSweeper();
    },
    onShutdown: async () => {
      const { stopRecurrenceScheduler } = await import("./api/scheduler.js");
      stopRecurrenceScheduler();
    },
  },
});
