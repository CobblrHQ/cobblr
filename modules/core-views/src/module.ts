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
  version: "0.1.0",
  displayName: "Views",
  description:
    "Saved filtered/sorted views per entity kind. List today; kanban, calendar, table land as renderers ship. Removes the need for every module to invent its own list page.",
  icon: "layout-list",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

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
  provides: { entityKinds: [] },

  exposes: {
    events: [
      "core-views.view.created",
      "core-views.view.updated",
      "core-views.view.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
