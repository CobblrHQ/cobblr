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
  version: "0.2.0",
  displayName: "Views",
  description:
    "Saved filtered/sorted views per entity kind. List today; kanban, calendar, table land as renderers ship. Removes the need for every module to invent its own list page.",
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

  intents: [
    { name: "save_view", description: "Save a filtered/sorted view for later" },
    { name: "render_view", description: "Fetch the rows a saved view should display" },
  ],

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
    api: [],
    actions: [
      {
        // WORKSPACE-scoped: it configures the workspace, it does not run on a
        // record. Rides invoke_action, so it inherits the confirm gate, the
        // permission check and the change ledger (labels:set-code precedent).
        id: "core-views:save-view",
        label: "Save a view",
        description:
          "Save a new view of one kind of record (a table, a list, a kanban board, a calendar or a gantt timeline), optionally pinned to the dashboard. Runs on the workspace, not a record. The view is shared with the whole workspace. Check what already exists with get_workspace_setup before adding another.",
        icon: "layout-dashboard",
        scope: "workspace",
        invokeHandler: "core-views.save-view",
        argsSchema: {
          entity_kind: { label: "Which kind of record (e.g. inventory:part)", type: "text" },
          name: { label: "What to call the view", type: "text" },
          view_type: { label: "table, list, kanban, calendar or gantt", type: "text" },
          pinned: { label: "Pin it to the dashboard", type: "boolean" },
        },
      },
    ],
  },

  subscribes: [],
});
