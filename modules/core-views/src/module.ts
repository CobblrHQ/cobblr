// core-views — saved views (filters, sort, layout) over any entity
// kind. The platform contract calls for kanban / calendar / gantt /
// table / list / hierarchy renderers; v0.1 ships the storage + a
// generic list-type renderer. Other view types land as the registry
// of supported types grows in the web bundle.
//
// Band: stock. Default-installed; users can disable to drop the
// /views endpoints (any module that handled its own list pages still
// works without core-views — this module is additive).
//
// Module-owned data: one tenant table, core_views_views, holding
// saved view configs. The "what data does this view show?" question
// is delegated to the kernel's list resolver (platform().entities
// .list()) — modules opt their kinds in by registering a list
// resolver alongside their existing single-entity resolver.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-views",
  version: "0.4.0",
  displayName: "Views",
  description:
    "Save the ways you like to see a list (filtered, sorted, as a board or a calendar) and come back to them.",
  icon: "layout-list",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  // Browse-not-configure: this is a page you VISIT, so it owns a nav entry
  // and one canonical URL rather than living under /configuration.
  nav: {
    label: "Views",
    route: "/views",
    icon: "layout-list",
  },

  schema: {
    tablePrefix: "core_views_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  // No entityKinds — views are an infrastructure concept, not a
  // domain entity end-users would attach files / actions to.
  // AI-REACH: no kinds by design. A saved view is READ through the shared
  // registry's get_workspace_setup (part: "views") and CREATED through the
  // workspace action below — declaring a kind to make it agent-reachable would
  // put views in nav and on the pairing/label surfaces, which they are not.
  provides: { entityKinds: [] },

  exposes: {
    events: [
      "core-views.view.created",
      "core-views.view.updated",
      "core-views.view.deleted",
    ],
    actions: [
      {
        // WORKSPACE-scoped, and also the way back for save-view (by view_id).
        group: "organise",
        // UI-SCREEN: /views
        id: "core-views:delete-view",
        runBy: "member",
        examples: ["delete the Idle machines board", "get rid of the old orders view"],
        undoable: true,
        label: "Remove a saved view",
        description:
          "Remove a saved view by its name. Only a view this person can see: one shared with the workspace, or their own. The records it showed are not touched, and Undo puts the view back.",
        icon: "trash-2",
        scope: "workspace" as const,
        invokeHandler: "core-views.delete-view",
        argsSchema: {
          view: { label: "Which view (its name)", type: "text" },
          view_id: { label: "The view's id, when it is known", type: "text" },
        },
      },
      {
        // WORKSPACE-scoped: it configures the workspace, it does not run on a
        // record. Rides invoke_action, so it inherits the confirm gate, the
        // permission check and the change ledger (labels:set-code precedent).
        // UI-SCREEN: /views
        group: "organise",
        id: "core-views:save-view",
        runBy: "member",
        examples: ["save this as a board", "make me a kanban of tasks"],
        undoable: true,
        label: "Save a view",
        description:
          "Save a new view of one kind of record (a table, a list, a kanban board, a calendar or a gantt timeline), optionally pinned to the dashboard. Runs on the workspace, not a record. The view is shared with the whole workspace. Check what already exists with get_workspace_setup before adding another. 'Save this as a board' means the screen the person is on (CURRENT VIEW: its kind, its filter): run it with a name taken from that screen ('Idle machines') rather than asking what to call it; they can rename it after.",
        icon: "layout-dashboard",
        scope: "workspace",
        invokeHandler: "core-views.save-view",
        argsSchema: {
          config: { label: "The view's configuration: columns, grouping, filters", type: "json" },
          entity_kind: { label: "Which kind of record (e.g. inventory:part)", type: "text", required: true },
          name: { label: "What to call the view", type: "text", required: true },
          view_type: { label: "table, list, kanban, calendar or gantt", type: "text", required: true },
          pinned: { label: "Pin it to the dashboard", type: "boolean" },
        },
      },
      {
        group: "organise",
        // UI-SCREEN: /views
        id: "core-views:edit-view",
        runBy: "member",
        examples: ["rename the Idle machines board to Free machines", "unpin the orders table"],
        undoable: true,
        label: "Change a saved view",
        description:
          "Rename a saved view, change its layout (table, list, kanban, calendar or gantt) or its columns and filters, or pin or unpin it on the dashboard. Only a view this person can see; a shared view stays shared.",
        icon: "layout-dashboard",
        scope: "workspace",
        invokeHandler: "core-views.edit-view",
        userInvokable: true,
        argsSchema: {
          view: { label: "Which view (its name)", type: "text", required: true },
          name: { label: "Its new name", type: "text" },
          view_type: { label: "table, list, kanban, calendar or gantt", type: "text" },
          config: { label: "Its configuration: columns, grouping, filters", type: "json" },
          pinned: { label: "Pin it to the dashboard (false to unpin)", type: "boolean" },
        },
      },
      {
        // NO-PHRASING: the way back for delete-view, run only from Undo
        group: "organise",
        id: "core-views:restore-view",
        runBy: "member",
        internal: true,
        examples: ["put the view back"],
        label: "Put a removed view back",
        description: "Internal, the inverse of removing a saved view: puts it back as it was, for whoever it belonged to. Runs from Undo on the card; not for direct use.",
        icon: "undo",
        scope: "workspace" as const,
        userInvokable: false,
        invokeHandler: "core-views.restore-view",
        argsSchema: {
          view: { label: "The removed view, as it was", type: "json" },
        },
      },
    ],
  },

  subscribes: [],
  lifecycle: {
    onBoot: async () => {
      // What it shows on the dashboard, read in its one request (#6563).
      const { registerViewsDashboardReads } = await import("./dashboard-reads.js");
      registerViewsDashboardReads();
    },
  },
});
