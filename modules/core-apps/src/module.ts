// core-apps — custom worker apps (H1, Tier A). A WorkspaceApp is a
// structured, declarative composition (pages → blocks) that a member
// opens in the portal to do their job. The App Player (web) renders
// it; every block resolves through the kernel's capability +
// field-read-scope (H2) boundary, so it's safe by construction — the
// app can never show or do anything the member's capabilities don't
// already allow.
//
// Band: stock. Default-installed; disable it and the worker-app
// surface simply isn't there (the portal still renders pinned views).
// "Stay structured" — this is NOT a freeform drag-drop builder; the
// view system + actions + custom fields ARE the customization layer.
// See docs/modules/custom-app-layer.md +
// docs/modules/member-portal-and-permissions.md.
//
// Module-owned data: one tenant table, core_apps_apps, holding app
// definitions. Blocks reference views (core-views), actions, and
// entity kinds — the player orchestrates those existing endpoints; this
// module just stores definitions + enforces who may open which app.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-apps",
  version: "0.1.1",
  displayName: "Apps",
  description:
    "Structured worker apps for the member portal: composed pages of views, actions, forms and stats, rendered by the App Player. Every block stays inside the capability + read-scope boundary.",
  icon: "layout-dashboard",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_apps_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [
    { name: "build_app", description: "Define a worker app (pages + blocks) for the portal" },
    { name: "open_app", description: "Open a worker app a member has access to" },
  ],

  dependencies: [],

  // No entityKinds — an app is an infrastructure/presentation concept,
  // not a domain entity end-users attach files / actions to.
  // AI-REACH: no kinds by design. A user-built app's RECORDS are reachable as
  // ordinary kinds (that is the point of the app), and the apps themselves are
  // read through get_workspace_setup (part: "apps"). Building one is the
  // authoring surface, which the MCP server exposes directly (cobblr_authoring_*).
  provides: { entityKinds: [] },

  exposes: {
    events: [
      "core-apps.app.created",
      "core-apps.app.updated",
      "core-apps.app.deleted",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],
});
