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
  version: "0.1.0",
  displayName: "Recurrence",
  description:
    "Schedule-triggered wires. Enable any wire to fire on an RRULE (every Monday 9am, the 1st of every month, etc.). Q4 from the wires-and-bundles spec.",
  icon: "calendar",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  intents: [],
  dependencies: [],

  api: () => import("./api/index.js"),

  // AI-REACH: no kinds/actions by design. A recurrence is a schedule attached
  // to another module's record, not a thing of its own; what it PRODUCES shows
  // up through list_calendar and the owning record's own kind.

  exposes: {
    events: ["core-recurrence.rule.fired"],
    api: ["tick"],
    actions: [],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      const { startRecurrenceScheduler } = await import("./api/scheduler.js");
      startRecurrenceScheduler();
    },
    onShutdown: async () => {
      const { stopRecurrenceScheduler } = await import("./api/scheduler.js");
      stopRecurrenceScheduler();
    },
  },
});
