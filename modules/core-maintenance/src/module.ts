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
  version: "0.2.18",
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

  provides: {
    entityKinds: [{
      // AI-CRUD: created by Renew so the schedule advances; paid history has no delete door.
      id: "core-maintenance:term", displayName: "Renewal term", displayNamePlural: "Renewal terms", icon: "calendar-clock",
      profile: "digital-record", overrides: { identity: null },
      getEndpoint: "/terms/{id}", listEndpoint: "/terms", updateEndpoint: "/terms/{id}",
      fields: [
        { name: "name", type: "text", role: "title", readOnly: true },
        { name: "term_start", type: "date" }, { name: "term_end", type: "date" },
        { name: "cost_cents", type: "number", money: "cents", label: "Cost" },
        { name: "currency", type: "text" }, { name: "reference", type: "text" },
        { name: "quantity", type: "number", label: "Seats or quantity" },
        { name: "publisher", type: "text", readOnly: true },
        { name: "entity_id", type: "text", readOnly: true }, { name: "schedule_id", type: "text", readOnly: true },
        { name: "performed_by", type: "text", readOnly: true }, { name: "metadata", type: "object" },
        { name: "performed_at", type: "date", label: "Renewed on", readOnly: true },
      ],
      exposableFields: ["name", "term_start", "term_end", "cost_cents", "currency", "reference", "quantity", "publisher", "entity_id", "schedule_id", "performed_by", "performed_at"],
    }],
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
        // UI-REACH: collection field edits maintain the bound renewal through an ordinary bundle wire.
        // DELIBERATELY universal: the collection wire supplies its own field binding; generic base kinds do not yet carry the instance traits at install.
        group: "service", id: "core-maintenance:ensure-renewal", label: "Keep a renewal scheduled", scope: "entity", appliesTo: { any: true }, wireOnly: true, internal: true, userInvokable: false,
        runBy: "member",
        description: "Keep one anchored renewal bound to a collection's expiry, billing and cancellation fields. Used by collection create and edit wires.",
        invokeHandler: "core-maintenance.ensure-renewal",
        argsSchema: Object.fromEntries(["expiry", "cycle", "custom_months", "auto_renews", "notice_days", "cost", "quantity", "publisher"].map(name => [name, { label: name.replace(/_/g, " "), type: "text" as const, required: true }])),
      },
      {
        // UI-SCREEN: /instances/:name
        group: "service", id: "core-maintenance:end-renewal", runBy: "member", label: "End renewal", scope: "workspace", icon: "calendar-x",
        invokeHandler: "core-maintenance.end-renewal", examples: ["I didn't renew the registration"],
        description: "End a renewal chain, stop future reminders and keep all past terms. Pass schedule_id from list_maintenance.",
        argsSchema: { schedule_id: { label: "Renewal", type: "text", required: true } },
      },
      {
        // UI-SCREEN: /instances/:name
        group: "service", id: "core-maintenance:update-term", runBy: "member", label: "Edit renewal term", scope: "workspace", icon: "pencil",
        undoable: true, invokeHandler: "core-maintenance.update-term", examples: ["the registration cost was actually $87"],
        description: "Correct a paid term from list_maintenance with terms true. Dates cannot overlap another term. Cost keeps its currency.",
        argsSchema: { term_id: { label: "Term", type: "text", required: true }, term_start: { label: "Start", type: "date" }, term_end: { label: "End", type: "date" }, cost: { label: "Cost", type: "text", money: true }, currency: { label: "Currency", type: "text" }, reference: { label: "PO or invoice", type: "text" }, quantity: { label: "Seats or quantity", type: "number" }, file_id: { label: "Document", type: "text" } },
      },
      {
        // UI-REACH: stock setup and job-use writers reconcile an automatic usage schedule, rather than offering a second service form.
        group: "service", id: "core-maintenance:ensure-usage", label: "Keep a usage service scheduled", internal: true, userInvokable: false,
        runBy: "member",
        description: "Keep one automatic service schedule for a record's usage counter and reconcile its open occurrence. The first interval starts at zero; completed service advances it normally. Repeated and concurrent calls keep one schedule and one due item.",
        scope: "workspace", invokeHandler: "core-maintenance.ensure-usage",
        argsSchema: { name: { label: "Service", type: "text", required: true }, counter_field: { label: "Usage counter", type: "text", required: true }, counter_every: { label: "Usage interval", type: "number", required: true } },
      },
      {
        group: "service", primary: true,
        id: "core-maintenance:log",
        runBy: "member",
        examples: ["changed the oil today", "log that I serviced it"],
        undoable: true,
        label: "Log service",
        // Disclosure: a collection that turned Service off loses this verb
        // along with the warranty fields; eligibility (physical, unique) stands.
        face: "maintained",
        description:
          "Record maintenance on this record: what was done and when, or schedule the next one. Pass `name` (what was done, e.g. \"oil change\"), and optionally `performed_at`, `scheduled_at`, `notes`, `cost` (what it cost, as an amount: 45 or \"$45.50\"), `recurrence_rule`, `address` (where it happens: a place from find_addresses, or the address as said; it becomes the calendar event's Where). With neither date it logs as done now. Reading the history is list_maintenance.",
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
          address: { label: "Where it happens", type: "json", address: true },
        },
      },
      {
        group: "service",
        id: "core-maintenance:schedule",
        runBy: "member",
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
        runBy: "member",
        description: "Keep a registration, inspection, licence, insurance or domain renewal on a fixed expiry. Enter the current expiry; the anchor defaults to that date every year. Choose a month-end anchor, interval, reminder and optional date field to bind it to.",
        examples: ["my passport expires next March", "remind me to renew this domain a month before it expires"],
        appliesTo: { traits: ["unique", "indefinite", "durable"] }, undoable: true, icon: "calendar-clock", invokeHandler: "core-maintenance.renewal",
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
        group: "service", id: "core-maintenance:reminders", runBy: "member", label: "Change maintenance reminders",
        description: "Snooze, stop or resume reminders for an open occurrence. Its overdue status stays visible. Pass entry_id from list_maintenance and mode; snooze takes duration week or month, or until as an ISO timestamp.",
        examples: ["stop reminding me about the inspection", "snooze the registration reminder for a month"],
        scope: "workspace", undoable: true, icon: "bell", invokeHandler: "core-maintenance.reminders",
        argsSchema: { entry_id: { label: "Service", type: "text", required: true }, mode: { label: "Reminders", type: "text", required: true, choices: [{ value: "snooze", label: "Snooze" }, { value: "stop", label: "Stop" }, { value: "resume", label: "Resume" }] }, duration: { label: "Snooze for", type: "text", choices: [{ value: "week", label: "1 week" }, { value: "month", label: "1 month" }] }, until: { label: "Snooze until", type: "text" } },
      },
      {
        // NO-PHRASING: inverse of changing an occurrence's reminders.
        group: "service", id: "core-maintenance:restore-reminders", label: "Restore maintenance reminders",
        runBy: "member",
        description: "Restore the previous snooze or stop state from Undo.", internal: true, userInvokable: false,
        scope: "workspace", icon: "undo", invokeHandler: "core-maintenance.restore-reminders",
        argsSchema: { entry_id: { label: "Service", type: "text", required: true }, nag_stopped_at: { label: "Previous stop", type: "text" }, nag_snoozed_until: { label: "Previous snooze", type: "text" } },
      },
      {
        // UI-SCREEN: /configuration/notification-audiences
        group: "service", id: "core-maintenance:reminder-default", label: "Set overdue reminder cadence",
        // ADMIN-ONLY: the page's own route PUT /reminders/preferences gates on this action's own id, owner or admin (reminders.ts)
        runBy: "admin",
        description: "Set the workspace default for overdue maintenance reminders to day, week, month or off. Each schedule can override it.",
        examples: ["remind us weekly about overdue maintenance"], scope: "workspace", icon: "bell", undoable: true, invokeHandler: "core-maintenance.reminder-default",
        argsSchema: { overdue_every: { label: "Overdue reminders", type: "text", required: true, choices: [{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }, { value: "month", label: "Monthly" }, { value: "off", label: "Off" }] } },
      },
      {
        // UI-SCREEN: /instances/:name
        group: "service", id: "core-maintenance:renew", runBy: "member", label: "Renew",
        examples: ["I renewed the inspection today, good till next March"],
        description: "Renew an anchored schedule. Pass schedule_id from list_maintenance, an optional new_expiry date, cost and notes. Early renewal keeps the next anchored expiry.",
        scope: "workspace" as const, icon: "calendar-check", invokeHandler: "core-maintenance.renew",
        argsSchema: {
          schedule_id: { label: "Schedule", type: "text", required: true },
          new_expiry: { label: "New expiry", type: "date" },
          term_start: { label: "Term start", type: "date" }, term_end: { label: "Term end", type: "date" },
          currency: { label: "Currency", type: "text" }, reference: { label: "PO or invoice", type: "text" }, quantity: { label: "Seats or quantity", type: "number" },
          cost: { label: "Cost", type: "text", money: true },
          notes: { label: "Notes", type: "text" },
          file_id: { label: "Document or receipt file", type: "text" },
        },
      },
      {
        // UI-SCREEN: /instances/:name
        group: "service", id: "core-maintenance:update-schedule", runBy: "member", label: "Change a service schedule",
        examples: ["remind me a month before the registration expires"],
        description: "Change a schedule by schedule_id from list_maintenance. Edit its interval, anchor, current_expiry or remind (before and unit, or on month_start).",
        scope: "workspace" as const, icon: "pencil", undoable: true, invokeHandler: "core-maintenance.update-schedule",
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
        // UI-SCREEN: /instances/:name
        // The record page's remove, for the assistant too (UI = API = MCP),
        // and the way back from setting a schedule. Not undoable, so every AI
        // door holds it for a person's confirm.
        group: "service",
        id: "core-maintenance:remove-schedule",
        runBy: "member",
        label: "Remove a service schedule",
        examples: ["stop tracking the oil change on the van", "remove the registration renewal"],
        description: "Remove a schedule by schedule_id from list_maintenance. Its open occurrence goes with it; the history it already rolled stays. Asks the person first.",
        icon: "trash-2",
        scope: "workspace" as const,
        userInvokable: false,
        undoable: false,
        invokeHandler: "core-maintenance.remove-schedule",
        argsSchema: {
          schedule_id: { label: "Schedule", type: "text", required: true },
        },
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "service",
        id: "core-maintenance:remove-entry",
        runBy: "member",
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
        runBy: "member",
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
        runBy: "member",
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
      {
        group: "service",
        id: "core-maintenance:renew-document",
        runBy: "member",
        examples: ["File this registration renewal", "Renew my car registration with this document"],
        label: "File a renewal document",
        description: "Renew the chosen record with the confirmed expiry, fee and reference, and keep the original in your Vault.",
        scope: "workspace",
        invokeHandler: "core-maintenance.renew-document",
        userInvokable: true,
        undoable: false,
        argsSchema: {
          document_type: { label: "Renewal type", type: "text" },
          record_kind: { label: "The record's collection", type: "text", required: true },
          record_id: { label: "The record", type: "text", required: true },
          previous_expiry: { label: "Previous expiry", type: "date", required: true },
          new_expiry: { label: "New expiry", type: "date", required: true },
          cost: { label: "Fee", type: "number" },
          currency: { label: "Currency", type: "text" },
          reference: { label: "Confirmation", type: "text" },
          folder: { label: "Your Vault folder", type: "text" },
          schedule_id: { label: "Renewal schedule", type: "text" },
        },
      },
      {
        // NO-PHRASING: runs only from the renewal's Undo
        group: "service",
        id: "core-maintenance:undo-document-renewal",
        runBy: "member",
        internal: true,
        label: "Undo a document renewal",
        description: "Restore the earlier renewal and remove the original filed by this change. Runs only from Undo.",
        scope: "workspace",
        userInvokable: false,
        invokeHandler: "core-maintenance.undo-document-renewal",
        argsSchema: {
          entry_id: { label: "Term", type: "text" },
          schedule_id: { label: "Schedule", type: "text" },
          vault_file_id: { label: "Document", type: "text" },
          folder_id: { label: "Folder", type: "text" },
          folder_name: { label: "Folder name", type: "text" },
          new_expiry: { label: "Expiry after renewal", type: "text" },
          before: { label: "Earlier renewal state", type: "json" },
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
        id: "core-maintenance:reminder-default", surface: "configuration-section", target: "notification-audiences", title: "Maintenance reminders",
      },
      {
        id: "core-maintenance:renewals", surface: "entity-detail-panel", target: "*", title: "Renewals", placement: "summary",
        // a renewal is for a thing you keep: never a job, order or project that gets finished, nor a pruned record
        appliesTo: { traits: ["unique", "indefinite", "durable"] },
        // and only where there is one, or in a collection of things that renew:
        // "No paid terms yet · Add a renewal" on a 3D printer was #6337. Adding
        // a first renewal stays in the record's actions (Keep a renewal scheduled).
        collections: ["subscriptions"],
        presence: true,
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
      const { registerTermsHeal } = await import("./heal-terms.js");
      registerTermsHeal();
      const { registerBoundRenewalsHeal } = await import("./heal-bound-renewals.js");
      registerBoundRenewalsHeal();
      const { registerTermResolvers } = await import("./term-resolvers.js");
      registerTermResolvers();
      const { startMaintenanceSweeper } = await import("./sweeper.js");
      startMaintenanceSweeper();
      const { registerMaintenanceContext, registerRenewalContext } = await import("./computed-context.js");
      registerMaintenanceContext();
      registerRenewalContext();
      const { registerMaintenanceCalendarSource } = await import("./calendar-source.js");
      registerMaintenanceCalendarSource();
      const { registerVisitAddresses } = await import("./visit-addresses.js");
      registerVisitAddresses();
    },
    onShutdown: async () => {
      const { stopMaintenanceSweeper } = await import("./sweeper.js");
      stopMaintenanceSweeper();
    },
  },
});
