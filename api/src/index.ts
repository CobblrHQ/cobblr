// Process entry point. Boot sequence:
//   1. Verify cobblr_meta is reachable
//   2. Run pending platform migrations
//   3. Register Platform implementation (so module loads can use it)
//   4. Load installed modules — registers manifests, runs module
//      side-effects (event subscribers, entity-resolver registrations,
//      action handlers)
//   5. Mirror manifests into entity_kinds / entity_actions registries
//   6. Build the Express app + platform routes
//   7. Mount each module's HTTP router
//   8. Add 404 + error handlers
//   9. Listen
//
// Migration failure crashes the boot intentionally — a half-migrated
// cobblr_meta is more dangerous than an offline api.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setPlatform } from "@cobblr/platform-contract";
import { env } from "./env.js";
import { metaPool, pingMeta } from "./db/meta.js";
import { runMigrations } from "./db/migrate.js";
import { getTenantDb } from "./db/tenant.js";
import { loadAllModules } from "./modules/loader.js";
import { mountModules } from "./modules/mount.js";
import * as activity from "./platform/activity.js";
import * as actions from "./platform/actions.js";
import * as entities from "./platform/entities.js";
import * as events from "./platform/events.js";
import * as templates from "./platform/templates.js";
import * as wires from "./platform/wires.js";
import { syncManifestRegistries } from "./platform/registry-sync.js";
import { backfillDefaultBindings } from "./platform/seed-bindings.js";
import { registerNotificationSubscribers } from "./platform/notification-subscribers.js";
import { completeApp, createApp } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function boot() {
  await pingMeta();
  const platformDir = resolve(__dirname, "..", "migrations", "platform");
  const result = await runMigrations({
    pool: metaPool,
    directory: platformDir,
    scope: "platform",
  });
  console.log(
    `[cobblr-api] platform migrations: ${result.applied.length} applied, ${result.alreadyApplied} already`,
  );

  // Register the platform implementation before module loads so the
  // module-load side effects (event subscriptions, entity resolver
  // registrations, action handler registrations) can call into it.
  setPlatform({
    activity: { log: activity.log },
    events: { emit: events.emit, on: events.on },
    tenants: { getDb: (orgId) => getTenantDb(orgId) },
    entities: {
      registerResolver: entities.registerResolver,
      lookup: entities.lookup,
      listKinds: entities.listKinds,
      getKind: entities.getKind,
    },
    actions: {
      registerHandler: actions.registerHandler,
      listApplicable: actions.listApplicable,
      invoke: actions.invoke,
    },
    templates: { render: templates.render },
    wires: { fireEvent: wires.fireEvent },
  });

  // Register platform-level event → notification mappers BEFORE
  // modules load so module-emitted events get caught from the very
  // first emit.
  registerNotificationSubscribers();

  await loadAllModules();
  // Mirror manifests into the cobblr_meta registries after load so
  // <EntityActionsBar> / platform.entities.lookup() etc. have
  // accurate metadata. Done AFTER load so module-side resolver /
  // handler registrations land first.
  await syncManifestRegistries();
  // Top up default bindings for orgs created before Phase 4 introduced
  // the seed-on-signup path. Idempotent per (org, source_kind, action_id,
  // trigger_event), so repeated boots are safe.
  const seeded = await backfillDefaultBindings();
  console.log(`[cobblr-api] default bindings backfilled: ${seeded} added`);

  const { app } = createApp();
  await mountModules(app);
  completeApp(app);

  const server = app.listen(env.API_PORT, () => {
    console.log(`[cobblr-api] listening on :${env.API_PORT} (${env.NODE_ENV})`);
  });

  function shutdown(signal: string) {
    console.log(`[cobblr-api] ${signal} received, draining`);
    server.close(() => {
      console.log("[cobblr-api] server closed");
      metaPool.end().finally(() => process.exit(0));
    });
    setTimeout(() => {
      console.error("[cobblr-api] graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

boot().catch((err) => {
  console.error("[cobblr-api] boot failed:", err);
  process.exit(1);
});
