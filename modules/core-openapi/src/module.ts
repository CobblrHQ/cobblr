// core-openapi — auto-generated OpenAPI 3.1 description of the
// running Cobblr universe. Builds from the entity-kind registry +
// a curated set of well-known platform routes.
//
// v0.1 — emits component schemas per entity kind + documents the
// platform-level routes (auth, orgs, modules, healthz, search,
// views, files, tags). Per-module CRUD routes are noted as
// well-known patterns but not enumerated per kind (modules can opt
// in to declaring their routes in a future contract iteration).
//
// Output is one big JSON blob at GET /openapi.json — point Swagger
// UI / Insomnia / curl at it.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-openapi",
  version: "0.1.0",
  displayName: "OpenAPI",
  description:
    "Auto-generated API description from the live module registry. Hand it to Swagger UI / Insomnia / any external integration.",
  icon: "file-text",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  // AI-REACH: none needed — generates the OpenAPI spec for the workspace's own
  // API. An agent that wants to know what exists asks list_record_kinds, which
  // is the same information in the form the tools already speak.

  provides: { entityKinds: [] },

  exposes: {
    events: [],
    api: ["spec"],
    actions: [],
  },

  subscribes: [],
});
