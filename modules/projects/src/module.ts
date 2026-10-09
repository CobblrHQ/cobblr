// Projects — third Cobblr connector.
//
// Projects + Tasks + cross-module task dependencies. The wire that
// auto-unblocks tasks when stock comes back is no longer a
// hardcoded subscription — it's a user-configurable binding that
// invokes the projects:set-dep-satisfied action declared below.
// The platform seeds the default binding on signup so out-of-the-
// box behavior matches the old hardcoded flow.

import { defineModule } from "@cobblr/platform-contract";
import { ENERGIES, PRIORITIES, PROJECT_STATUSES, TASK_STATUSES } from "./vocab.js";

export default defineModule({
  name: "projects",
  version: "0.3.32",
  displayName: "Projects",
  description:
    "Projects and their tasks, with what each task is waiting for.",
  icon: "layers",
  band: "stock",
  instanceability: "multi",

  schema: {
    tablePrefix: "projects_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  // Pillar A — entity kinds we provide
  provides: {
    entityKinds: [
      {
        id: "projects:project",
        primary: true,
        createEndpoint: "/projects",
        updateEndpoint: "/projects/{id}",
        deleteEndpoint: "/projects/{id}",
        displayName: "Project",
        displayNamePlural: "Projects",
        icon: "layers",
        profile: "work-item" /* digital · unique · — · schedulable · completable · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "status", type: "text", choices: [...PROJECT_STATUSES] },
          { name: "priority", type: "text", choices: [...PRIORITIES] },
          { name: "start_date", type: "date" },
          { name: "target_date", type: "date" },
          // A bundle's custom fields, as on every other instance-backed kind.
          { name: "metadata", type: "object" },
        ],
        // Public face — everything except internal flags. Status + start/target
        // dates are needed for cross-module displays (Kanban over multiple
        // modules, due-date + gantt-timeline views, notification context).
        exposableFields: [
          "name",
          "description",
          "status",
          "priority",
          "start_date",
          "target_date",
          "metadata",
        ],
        detailRoute: "/projects/{id}",
      },
      {
        id: "projects:task",
        createEndpoint: "/tasks",
        updateEndpoint: "/tasks/{id}",
        deleteEndpoint: "/tasks/{id}",
        displayName: "Task",
        displayNamePlural: "Tasks",
        icon: "check-square",
        profile: "work-item" /* digital · unique · — · schedulable · completable · durable */,
        fields: [
          { name: "title", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "status", type: "text", choices: [...TASK_STATUSES] },
          { name: "priority", type: "text", choices: [...PRIORITIES] },
          { name: "energy", type: "text", choices: [...ENERGIES] },
          { name: "due_date", type: "date" },
          // A task's custom fields: without it a view grouped or laid out by
          // one reads every task as "No value".
          { name: "metadata", type: "object" },
        ],
        // All fields are public-facing — tasks show up everywhere (notifications,
        // dependent-of-X views, dashboards).
        exposableFields: [
          "title",
          "description",
          "status",
          "priority",
          "energy",
          "due_date",
          "metadata",
        ],
        detailRoute: "/projects/tasks/{id}",
      },
    ],
  },

  dependencies: [],

  exposes: {
    // The KINDS of workspace notification this module sends, so the
    // workspace can say who each kind is for (Configuration > Who gets told).
    notifications: [
      { eventType: "projects.task.unblocked", label: "A task became unblocked", description: "A task whose blockers are all done." },
      { eventType: "projects.task.assigned", label: "A task was given to you", description: "Someone assigned you a task." },
    ],
    events: [
      "projects.project.created",
      "projects.project.updated",
      "projects.task.created",
      "projects.task.updated",
      "projects.task.completed",
      "projects.task.unblocked",
      "projects.task.assigned",
    ],
    actions: [
      {
        group: "plan",
        id: "projects:blocked-by",
        runBy: "member",
        examples: ["this is waiting on that", "cannot start until the part arrives"],
        undoable: true,
        label: "Mark as waiting on something",
        description:
          "Record that this task cannot start until something else is done. Pass EITHER `depends_on_task_id` (another task) OR `blocks_kind` + `blocks_id` (any record, e.g. a purchase order that has to arrive first). The task then shows as blocked until that dependency is satisfied.",
        icon: "link",
        appliesTo: { kinds: ["projects:task"] },
        invokeHandler: "projects.blocked-by",
        argsSchema: {
          depends_on_task_id: { label: "Id of the task this waits on", type: "text", oneOf: "waits-on" },
          blocks_kind: { label: "Kind of record this waits on (e.g. purchases:order)", type: "text", with: "blocks_id" },
          blocks_id: { label: "Id of that record", type: "text", oneOf: "waits-on", with: "blocks_kind" },
        },
      },
      {
        group: "plan",
        id: "projects:unblock",
        runBy: "member",
        examples: ["it is not waiting on that any more", "remove that dependency"],
        undoable: true,
        label: "Remove a dependency",
        description:
          "Delete one dependency from a task, so it stops waiting on that thing. Pass `dependency_id` (reading a task's dependencies returns their ids). Removing the dependency does not mark anything done.",
        icon: "unlink",
        scope: "workspace" as const,
        invokeHandler: "projects.unblock",
        argsSchema: { dependency_id: { label: "Id of the dependency to remove", type: "text", required: true } },
      },
      {
        group: "plan",
        id: "projects:move-task",
        runBy: "member",
        examples: ["put this task first", "move that one down", "do this one last"],
        undoable: true,
        label: "Move in the list",
        description:
          "Move this task within its project's list. Pass `to` (first, last, up or down) or `position` (its place counting from 1). The list on the project page shows the same order.",
        icon: "arrow-up-down",
        appliesTo: { kinds: ["projects:task"] },
        invokeHandler: "projects.move-task",
        argsSchema: {
          to: {
            label: "Where to",
            type: "text",
            oneOf: "where",
            choices: [
              { value: "first", label: "First" },
              { value: "up", label: "Up one" },
              { value: "down", label: "Down one" },
              { value: "last", label: "Last" },
            ],
          },
          position: { label: "Or its place in the list, counting from 1", type: "number", oneOf: "where" },
        },
      },
      {
        // NO-PHRASING: flips flags for whatever entity triggered it, so without an event there is nothing to act on
        group: "plan",
        id: "projects:set-dep-satisfied",
        runBy: "member",
        label: "Mark task dependencies satisfied",
        description:
          "For every task dep referencing the triggering entity, flip satisfied = true",
        // DELIBERATELY universal: a task dependency can reference ANY kind
        // (a part restocks, an order arrives, a print finishes) — the dep
        // table names the triggering entity; scoping would break the pattern.
        appliesTo: { any: true },
        invokeHandler: "projects.set-dep-satisfied",
        // Wire-only — fired by the stock-changed wire, not a button.
        // Clicking it manually on an arbitrary entity is meaningless.
        wireOnly: true,
        userInvokable: false,
      },
      {
        // NO-PHRASING: the way back for another action, run only from Undo
        group: "plan",
        id: "projects:reopen-task",
        runBy: "member",
        internal: true,
        label: "Put a task back",
        description: "Internal, the inverse of marking a task done: puts its status and completion back to what they were. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "projects.reopen-task",
        argsSchema: {
          task_id: { label: "The task's id", type: "text" },
          status: { label: "The status to put back", type: "text" },
          completed_at: { label: "When it said it was completed, or blank", type: "text" },
        },
      },
      {
        // NO-PHRASING: acts on the task named by the event; asked without one there is no task to mark
        group: "plan",
        id: "projects:mark-task-done",
        runBy: "member",
        undoable: true,
        wireOnly: true,
        label: "Mark linked task done",
        description:
          "Set the task named by the event's linkedTaskId to done (e.g. when a linked print completes)",
        // DELIBERATELY universal: fired by upstream completion events; the
        // task is located from the event's linkedTaskId, not the source kind.
        appliesTo: { any: true },
        invokeHandler: "projects.mark-task-done",
        // Wire-only — fired by an upstream completion event, not a button.
        userInvokable: false,
      },
    ],
  },

  // Subscribes is informational — the actual reaction happens
  // through user-configurable wires (seeded at signup / module enable).
  subscribes: ["inventory.stock.changed", "digifab.print.confirmed"],

  // Reactions ship as wires, not hardcoded code, so users can edit /
  // disable / replace them. The wires belong to projects because
  // projects owns the actions they fire.
  contributes: {
    // Whose job a task is: anyone on the workspace's People list, member or
    // not. No role: the `assignee` role means "who has it now" for a thing
    // that gets lent, and a task is not lent.
    fieldDefs: [
      { entity_kind: "projects:task", name: "assignee", display_label: "Assigned to", type: "person" as const },
    ],
    wires: [
      // Auto-unblock a task when its part comes back in stock.
      {
        source_kind: "inventory:part",
        action_id: "projects:set-dep-satisfied",
        trigger_type: "event",
        trigger_event: "inventory.stock.changed",
      },
      // Auto-close a task when its linked print is CONFIRMED good (F-13). Not on
      // raw `completed` — a manager's "completed" only means the gcode finished,
      // not that a good part exists, and silently closing the human's task on a
      // spaghetti-failed print is the one effect too costly to get wrong. The
      // bed-clear "good" verdict emits digifab.print.confirmed (carrying
      // linkedTaskId); the handler reads it directly.
      {
        source_kind: "digifab:job",
        action_id: "projects:mark-task-done",
        trigger_type: "event",
        trigger_event: "digifab.print.confirmed",
      },
    ],
  },

  lifecycle: {
    onBoot: async () => {
      // One-shot heal: keep the words of pattern PDFs read before words were
      // kept (see heal-pattern-text.ts for the retirement condition).
      const { registerPatternTextHeal } = await import("./api/heal-pattern-text.js");
      registerPatternTextHeal();
    },
  },
});
