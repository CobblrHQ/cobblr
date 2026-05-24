// core-public-surfaces — token-gated, no-auth public read endpoints.
//
// The platform mounts a `/api/v1/public/:token` route that resolves
// the token to a tenant + surface and returns the configured data
// (today: a view's items, or a single entity). All projection goes
// through the kind's exposableFields, so the public response never
// leaks anything the kind hasn't declared as cross-module-readable.
//
// Storage split:
//   tenant DB                : surface configs (name, scope, theme)
//   cobblr_meta              : token → org_id → surface_id lookup
//
// Why split: the public URL is /public/:token with no slug, so the
// router needs to find the tenant in one query. Scanning every
// tenant DB for a matching token doesn't scale. The meta-side index
// is just denormalized for fast lookup; tenant side remains the
// source of truth.
//
// This module ALSO mounts the public route itself — that's why it
// needs a non-standard side-effecting api/index.ts that registers
// the public path with the platform's route table at boot.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-public-surfaces",
  version: "0.1.0",
  displayName: "Public Surfaces",
  description:
    "Token-gated public read URLs. Share a view or an entity over a long-random URL without anyone needing to sign in. Per-surface enable/disable + revoke.",
  icon: "globe",
  band: "stock",

  schema: {
    tablePrefix: "core_public_surfaces_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  intents: [
    { name: "publish_surface", description: "Share a view or entity over a public URL" },
    { name: "revoke_surface", description: "Kill a previously-published URL" },
  ],

  dependencies: [],

  provides: { entityKinds: [] },

  exposes: {
    events: [
      "core-public-surfaces.surface.created",
      "core-public-surfaces.surface.revoked",
      "core-public-surfaces.surface.viewed",
    ],
    api: [],
    actions: [],
  },

  subscribes: [],

  lifecycle: {
    onBoot: async () => {
      // Daily retention sweep for the view-log table, driven via
      // core-queue. Registers the worker handler and seeds a first
      // job per workspace if none is pending. Idempotent.
      const { startRetentionWorker } = await import("./api/retention.js");
      await startRetentionWorker();
    },
  },
});
