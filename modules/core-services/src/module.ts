// core-services: owner of the Services job tables.
//
// A job (one call of a service capability) is workspace data, so it lives in
// the tenant database beside the records it produces files for. There is no
// platform-owned tenant table mechanism that reaches existing workspaces
// (tenant-base migrations run only when a workspace is provisioned), so a
// foundational module owns the schema, as core-placement does for placement.
// The seam is platform().services (api/src/platform/services.ts).
//
// AI-REACH: the assistant reaches Services through list_services and
// invoke_service (the chat tools), not through this module, which only owns
// the job tables.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-services",
  version: "0.2.0",
  displayName: "Services",
  description:
    "The jobs of the outside services your workspace calls (design a part, slice a model): each call's input, status, answer and files, in one place every app can use.",
  icon: "plug",
  band: "foundational",
  schema: {
    tablePrefix: "core_services_",
    migrationsDir: "./migrations",
  },
  dependencies: ["core-files"],
  exposes: {
    events: ["services.job.updated", "services.job.done", "services.job.failed", "services.job.needs_input"],
  },
  subscribes: [],
});
