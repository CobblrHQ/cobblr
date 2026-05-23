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
  version: "0.1.0",
  displayName: "Projects",
  description:
    "Projects + tasks + dependencies. Tasks can wait on other tasks or on any module's entity — the platform brokers.",
  icon: "layers",
  band: "stock",

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
        displayName: "Project",
        displayNamePlural: "Projects",
        icon: "layers",
        profile: "work-item" /* digital · unique · — · schedulable · completable · durable */,
        fields: [
          { name: "name", type: "text", role: "title", required: true },
          { name: "description", type: "text", role: "summary" },
          { name: "status", type: "text" },
          { name: "priority", type: "text" },
          { name: "target_date", type: "date" },
        ],
        // Public face — everything except internal flags. Status + target_date
        // are needed for cross-module displays (Kanban over multiple modules,
        // due-date views, notification context).
        exposableFields: [
          "name",
          "description",
          "status",
          "priority",
          "target_date",
        ],
        detailRoute: "/projects/{id}",
      },
      {
        id: "projects:task",
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
        id: "projects:set-dep-satisfied",
        label: "Mark task dependencies satisfied",
        description:
          "For every task dep referencing the triggering entity, flip satisfied = true",
        appliesTo: { any: true },
        invokeHandler: "projects.set-dep-satisfied",
        // Wire-only — fired by the stock-changed wire, not a button.
        // Clicking it manually on an arbitrary entity is meaningless.
        userInvokable: false,
      },
    ],
  },

  // Subscribes is informational — the actual reaction happens
  // through a user-configurable wire (seeded at signup).
  subscribes: ["inventory.stock.changed"],
});
