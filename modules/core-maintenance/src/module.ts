// core-maintenance — per-entity service log.
//
// Tracks "this was done" and "this is due" for any entity in any
// module. Polymorphic over (entity_module, entity_type, entity_id).
// The killer HomeBox-parity feature: warranty cards + service
// schedules on a household asset, oil-change history on a machine,
// firmware-flash dates on a 3D printer.
//
// Foundational. Other modules don't depend on this directly; the UI
// surfaces a Maintenance panel on entities that opt in.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-maintenance",
  version: "0.2.8",
  displayName: "Maintenance",
  description:
    "Remember when things need servicing: log what was done and get a reminder when the next one is due.",
  icon: "calendar-check",
  // Capability, not foundational: the platform runs fine without it (nothing
  // depends on it — it just surfaces an opt-in Maintenance panel on entities).
  // `autoEnable` keeps it on for every workspace as before, but `stock` means a
  // workspace that doesn't want it can now turn it off (foundational can't be).
  band: "stock",
  autoEnable: true,

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Maintenance",
    route: "/maintenance",
    icon: "wrench",
  },

  schema: {
    tablePrefix: "core_maintenance_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  // AI-REACH: no kinds by design (entries hang off the entity they service
  // rather than standing alone in nav). Read through the shared registry's
  // list_maintenance tool, which filters at the source (kind=scheduled,
  // due_within_days) so "what is due" is answered without paging everything.

  provides: {
    entityKinds: [],
  },

  exposes: {
    // The KINDS of workspace notification this module sends, so the
    // workspace can say who each kind is for (Configuration > Who gets told).
    notifications: [
      { eventType: "maintenance.due-soon", label: "Maintenance due", description: "Scheduled upkeep that is due or overdue, once a day." },
    ],
    events: [
      "core-maintenance.entry.created",
      "core-maintenance.entry.updated",
      "core-maintenance.entry.deleted",
      "core-maintenance.schedule.created",
      "core-maintenance.entry.due-soon",
      // (removed core-maintenance.entry.overdue — declared but never emitted;
      //  the sweeper only emits due-soon. Audit 2026-06-26 follow-up.)
    ],
    actions: [
      {
        group: "service", primary: true,
        id: "core-maintenance:log",
        examples: ["changed the oil today", "log that I serviced it"],
        undoable: true,
        label: "Log service",
        // Disclosure: a collection that turned Service off loses this verb
        // along with the warranty fields; eligibility (physical, unique) stands.
        face: "maintained",
        description:
          "Record maintenance on this record: what was done and when, or schedule the next one. Pass `name` (what was done, e.g. \"oil change\"), and optionally `performed_at`, `scheduled_at`, `notes`, `cost` (what it cost, as an amount: 45 or \"$45.50\"), `recurrence_rule`. With neither date it logs as done now. Reading the history is list_maintenance.",
        icon: "wrench",
        // Anything a workspace OWNS can need servicing: a mower, a printer, a
        // vehicle, a water filter, a lease. That is physical + unique. It was
        // declared universal, which also put "Log service" on every box of
        // screws and every tea bag - fungible stock is bought, used and
        // replaced, never serviced (audit, 2026-09-08). The two traits are the
        // vocabulary for exactly that line, and a workspace can still widen it
        // per action on /actions.
        appliesTo: { traits: ["physical", "unique"] },
        invokeHandler: "core-maintenance.log",
        argsSchema: {
          description: { label: "Longer description of the work (optional)", type: "text" },
          recurrence_rule: { label: "How often it repeats, as an RRULE (optional)", type: "text" },
          name: { label: "What was done", type: "text", required: true },
          performed_at: { label: "When it was done (ISO date)", type: "text" },
          scheduled_at: { label: "When it is next due (ISO date)", type: "text" },
          notes: { label: "Notes", type: "text" },
          cost: { label: "What it cost", type: "text", money: true },
          schedule_id: { label: "The schedule it belongs to (optional; matched by name otherwise)", type: "text" },
        },
      },
      {
        group: "service",
        id: "core-maintenance:schedule",
        examples: ["change the oil every 3 months", "service the printer every 200 print hours"],
        undoable: true,
        label: "Set a service schedule",
        face: "maintained",
        description:
          "Set when this record needs servicing. For a renewal pass anchor (MM-DD or {month, last_day: true}), current_expiry, optional expiry_field, and remind ({before, unit} or {on: month_start}). Otherwise say how often this record wants servicing, by the calendar (`every_n` + `every_unit`: day, week, month, year) or by a usage counter the record keeps (`counter_every` + `counter_field`, e.g. 200 print_hours), or both. Its next service is then always scheduled, logging the service rolls it forward, and it is flagged when due.",
        icon: "calendar-clock",
        appliesTo: { traits: ["physical", "unique"] },
        invokeHandler: "core-maintenance.schedule",
        argsSchema: {
          anchor: { label: "Fixed month and day, or the last day of a month", type: "json", oneOf: "interval", with: "current_expiry" },
          current_expiry: { label: "Current expiry", type: "date", with: "anchor" },
          expiry_field: { label: "The record date field that holds the expiry", type: "text" },
          remind: { label: "Reminder lead time or the first day of the month", type: "json" },
          overdue_every: { label: "Overdue cadence: day, week, month or off", type: "text" },
          name: { label: "What needs doing", type: "text", required: true },
          every_n: { label: "How often: every", type: "number", oneOf: "interval", with: "every_unit" },
          every_unit: {
            label: "Days, weeks, months or years",
            type: "text",
            with: "every_n",
            choices: [
              { value: "day", label: "Days" },
              { value: "week", label: "Weeks" },
              { value: "month", label: "Months" },
              { value: "year", label: "Years" },
            ],
          },
          counter_every: { label: "Or by use: every", type: "number", oneOf: "interval", with: "counter_field" },
          counter_field: { label: "Of what", type: "text", with: "counter_every", choicesFrom: "counters" },
          last_done_at: { label: "When it was last done", type: "date", ask: true },
        },
      },
      {
        group: "service", id: "core-maintenance:renewal", label: "Add a renewal",
        description: "Keep a registration, inspection, licence, insurance or domain renewal on a fixed expiry. Enter the current expiry; the anchor defaults to that date every year. Choose a month-end anchor, interval, reminder and optional date field to bind it to.",
        examples: ["my passport expires next March", "remind me to renew this domain a month before it expires"],
        appliesTo: { traits: ["unique"] }, undoable: true, icon: "calendar-clock", invokeHandler: "core-maintenance.renewal",
        argsSchema: {
          name: { label: "What expires", type: "text", required: true },
          current_expiry: { label: "Current expiry", type: "date", required: true },
          anchor: { label: "Month and day, or the last day of a month", type: "json" },
          every_n: { label: "Every", type: "number" }, every_unit: { label: "Months or years", type: "text" },
          remind: { label: "Reminder lead time or the first day of the month", type: "json" },
          expiry_field: { label: "Expiry date field", type: "text" }, overdue_every: { label: "Overdue cadence", type: "text" },
        },
      },
      {
        // UI-SCREEN: /maintenance
        group: "service", id: "core-maintenance:reminders", label: "Change maintenance reminders",
        description: "Snooze, stop or resume reminders for an open occurrence. Its overdue status stays visible. Pass entry_id from list_maintenance and mode; snooze takes duration week or month, or until as an ISO timestamp.",
        examples: ["stop reminding me about the inspection", "snooze the registration reminder for a month"],
        scope: "workspace", undoable: true, icon: "bell", invokeHandler: "core-maintenance.reminders",
        argsSchema: { entry_id: { label: "Service", type: "text", required: true }, mode: { label: "Reminders", type: "text", required: true, choices: [{ value: "snooze", label: "Snooze" }, { value: "stop", label: "Stop" }, { value: "resume", label: "Resume" }] }, duration: { label: "Snooze for", type: "text", choices: [{ value: "week", label: "1 week" }, { value: "month", label: "1 month" }] }, until: { label: "Snooze until", type: "text" } },
      },
      {
        // NO-PHRASING: inverse of changing an occurrence's reminders.
        group: "service", id: "core-maintenance:restore-reminders", label: "Restore maintenance reminders",
        description: "Restore the previous snooze or stop state from Undo.", internal: true, userInvokable: false,
        scope: "workspace", icon: "undo", invokeHandler: "core-maintenance.restore-reminders",
        argsSchema: { entry_id: { label: "Service", type: "text", required: true }, nag_stopped_at: { label: "Previous stop", type: "text" }, nag_snoozed_until: { label: "Previous snooze", type: "text" } },
      },
      {
        // UI-SCREEN: /configuration/notification-audiences
        group: "service", id: "core-maintenance:reminder-default", label: "Set overdue reminder cadence",
        description: "Set the workspace default for overdue maintenance reminders to day, week, month or off. Each schedule can override it.",
        examples: ["remind us weekly about overdue maintenance"], scope: "workspace", icon: "bell", invokeHandler: "core-maintenance.reminder-default",
        argsSchema: { overdue_every: { label: "Overdue reminders", type: "text", required: true, choices: [{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }, { value: "off", label: "Off" }] } },
      },
      {
        // UI-SCREEN: /instances/:name
        group: "service", id: "core-maintenance:renew", label: "Renew",
        examples: ["I renewed the inspection today, good till next March"],
        description: "Renew an anchored schedule. Pass schedule_id from list_maintenance, an optional new_expiry date, cost and notes. Early renewal keeps the next anchored expiry.",
        scope: "workspace" as const, icon: "calendar-check", invokeHandler: "core-maintenance.renew",
        argsSchema: {
          schedule_id: { label: "Schedule", type: "text", required: true },
          new_expiry: { label: "New expiry", type: "date" },
          cost: { label: "Cost", type: "text", money: true },
          notes: { label: "Notes", type: "text" },
          file_id: { label: "Document or receipt file", type: "text" },
        },
      },
      {
        // UI-SCREEN: /instances/:name
        group: "service", id: "core-maintenance:update-schedule", label: "Change a service schedule",
        examples: ["remind me a month before the registration expires"],
        description: "Change a schedule by schedule_id from list_maintenance. Edit its interval, anchor, current_expiry or remind (before and unit, or on month_start).",
        scope: "workspace" as const, icon: "pencil", invokeHandler: "core-maintenance.update-schedule",
        argsSchema: {
          schedule_id: { label: "Schedule", type: "text", required: true },
          name: { label: "Name", type: "text" },
          every_n: { label: "Every", type: "number" }, every_unit: { label: "Unit", type: "text" },
          counter_field: { label: "Counter", type: "text" }, counter_every: { label: "Usage interval", type: "number" },
          overdue_every: { label: "Overdue cadence: day, week, month or off", type: "text" },
          anchor: { label: "Anchor", type: "json" }, remind: { label: "Reminder", type: "json" },
          current_expiry: { label: "Expiry", type: "date" },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "service",
        id: "core-maintenance:remove-schedule",
        internal: true,
        label: "Remove a service schedule",
        description: "Internal, the inverse of setting a schedule: removes it and its open occurrence. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "core-maintenance.remove-schedule",
        argsSchema: {
          schedule_id: { label: "The schedule's id", type: "text" },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "service",
        id: "core-maintenance:remove-entry",
        internal: true,
        label: "Remove a maintenance entry",
        description: "Internal, the inverse of logging maintenance: removes the entry again. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "core-maintenance.remove-entry",
        argsSchema: {
          entry_id: { label: "The entry's id", type: "text" },
          schedule_was: { label: "The schedule state to put back, if the entry rolled one", type: "json" },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "service",
        id: "core-maintenance:reopen-entry",
        internal: true,
        label: "Reopen a maintenance entry",
        description: "Internal, the inverse of completing an entry: puts back when and by whom it said it was done, or none. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "core-maintenance.reopen-entry",
        argsSchema: {
          entry_id: { label: "The entry's id", type: "text" },
          performed_at: { label: "When it said it was done, or blank", type: "text" },
          performed_by: { label: "Who it said did it, or blank", type: "text" },
          schedule_was: { label: "Previous service schedule", type: "json" },
        },
      },
      {
        // UI-SCREEN: /maintenance
        group: "service",
        id: "core-maintenance:complete",
        examples: ["that service is done"],
        undoable: true,
        label: "Mark service done",
        description:
          "Mark a SCHEDULED maintenance entry as done. Pass `entry_id` (list_maintenance returns ids) and optionally `performed_at`; it defaults to now.",
        icon: "check",
        scope: "workspace" as const,
        invokeHandler: "core-maintenance.complete",
        argsSchema: {
          entry_id: { label: "The scheduled entry's id", type: "text", required: true },
          performed_at: { label: "When it was done (ISO date)", type: "text" },
        },
      },
    ],
  },

  // "Service every… [3 months ▾]" on any record that can be serviced: the
  // same eligibility as Log service (physical + unique) and the same face,
  // so a collection that turned Service off loses both together (#3876).
  contributes: {
    panels: [
      {
        id: "core-maintenance:renewals", surface: "entity-detail-panel", target: "*", title: "Renewals", placement: "summary",
        appliesTo: { traits: ["unique"] },
      },
      {
        id: "core-maintenance:schedules",
        surface: "entity-detail-panel" as const,
        target: "*",
        title: "Service schedule",
        appliesTo: { traits: ["physical", "unique"] },
        face: "maintained",
      },
    ],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      const { startMaintenanceSweeper } = await import("./sweeper.js");
      startMaintenanceSweeper();
      const { registerMaintenanceContext } = await import("./computed-context.js");
      registerMaintenanceContext();
      const { registerMaintenanceCalendarSource } = await import("./calendar-source.js");
      registerMaintenanceCalendarSource();
    },
    onShutdown: async () => {
      const { stopMaintenanceSweeper } = await import("./sweeper.js");
      stopMaintenanceSweeper();
    },
  },
});
