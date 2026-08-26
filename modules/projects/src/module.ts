// Projects — third Cobblr connector.
//
// Projects + Tasks + cross-module task dependencies. The wire that
// auto-unblocks tasks when stock comes back is no longer a
// hardcoded subscription — it's a user-configurable binding that
// invokes the projects:set-dep-satisfied action declared below.
// The platform seeds the default binding on signup so out-of-the-
// box behavior matches the old hardcoded flow.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "projects",
  version: "0.3.0",
  displayName: "Projects",
  description:
    "Projects + tasks + dependencies. Tasks can wait on other tasks or on any module's entity, the platform brokers.",
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
          { name: "status", type: "text" },
          { name: "priority", type: "text" },
          { name: "start_date", type: "date" },
          { name: "target_date", type: "date" },
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
          { name: "status", type: "text" },
          { name: "priority", type: "text" },
          { name: "energy", type: "text" },
          { name: "due_date", type: "date" },
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
        ],
        detailRoute: "/projects/tasks/{id}",
      },
    ],
  },

  intents: [
    { name: "add_task", description: "Add a task to a project (or standalone)" },
    { name: "complete_task", description: "Mark a task done" },
  ],

  dependencies: [],

  exposes: {
    events: [
      "projects.project.created",
      "projects.project.updated",
      "projects.task.created",
      "projects.task.updated",
      "projects.task.completed",
      "projects.task.unblocked",
    ],
    api: ["getProjectById", "getTaskById", "createTask", "completeTask"],
    actions: [
      {
        id: "projects:blocked-by",
        examples: ["this is waiting on that", "cannot start until the part arrives"],
        undoable: true,
        label: "Mark as waiting on something",
        description:
          "Record that this task cannot start until something else is done. Pass EITHER `depends_on_task_id` (another task) OR `blocks_kind` + `blocks_id` (any record, e.g. a purchase order that has to arrive first). The task then shows as blocked until that dependency is satisfied.",
        icon: "link",
        appliesTo: { kinds: ["projects:task"] },
        invokeHandler: "projects.blocked-by",
        argsSchema: {
          depends_on_task_id: { label: "Id of the task this waits on", type: "text" },
          blocks_kind: { label: "Kind of record this waits on (e.g. purchases:order)", type: "text" },
          blocks_id: { label: "Id of that record", type: "text" },
        },
      },
      {
        id: "projects:unblock",
        examples: ["it is not waiting on that any more", "remove that dependency"],
        undoable: true,
        label: "Remove a dependency",
        description:
          "Delete one dependency from a task, so it stops waiting on that thing. Pass `dependency_id` (reading a task's dependencies returns their ids). Removing the dependency does not mark anything done.",
        icon: "unlink",
        scope: "workspace" as const,
        invokeHandler: "projects.unblock",
        argsSchema: { dependency_id: { label: "Id of the dependency to remove", type: "text" } },
      },
      {
        // NO-PHRASING: flips flags for whatever entity triggered it, so without an event there is nothing to act on
        id: "projects:set-dep-satisfied",
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
        userInvokable: false,
      },
      {
        // NO-PHRASING: acts on the task named by the event; asked without one there is no task to mark
        id: "projects:mark-task-done",
        undoable: true,
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
});
