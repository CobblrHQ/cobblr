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
import { sql, type Kysely } from "kysely";
import { env } from "./env.js";
import { meta, metaPool, pingMeta } from "./db/meta.js";
import { runMigrations } from "./db/migrate.js";
import { getTenantDb, releaseIdleTenantPool } from "./db/tenant.js";
import { signAppToken } from "./auth/jwt.js";
import { loadAllModules } from "./modules/loader.js";
import { loadAllSandboxedModules } from "./sandbox/loader.js";
import { syncTenantMigrations } from "./modules/enable.js";
import { mountModules } from "./modules/mount.js";
import * as activity from "./platform/activity.js";
import * as actions from "./platform/actions.js";
import * as entities from "./platform/entities.js";
import * as files from "./platform/files.js";
import * as events from "./platform/events.js";
import * as templates from "./platform/templates.js";
import * as wires from "./platform/wires.js";
import * as health from "./platform/health.js";
import * as recurrenceRegistry from "./platform/recurrence-registry.js";
import * as calendarRegistry from "./platform/calendar-registry.js";
import { registerDateFieldCalendarSources } from "./platform/date-field-calendar.js";
import * as computedFields from "./platform/computed-fields.js";
import * as createDefaults from "./platform/create-defaults.js";
import * as instancesImpl from "./platform/instances.js";
import * as queue from "./platform/queue.js";
import * as notificationsImpl from "./platform/notifications.js";
import * as integrationsImpl from "./platform/integrations.js";
import * as aiImpl from "./platform/ai.js";
import { syncManifestRegistries } from "./platform/registry-sync.js";
import { syncInstalledModules } from "./platform/installed-modules.js";
import { migrateLensModules } from "./platform/migrate-lens-modules.js";
import { migrateInventoryLocations } from "./platform/migrate-inventory-locations.js";
import { backfillDefaultBindings } from "./platform/seed-bindings.js";
import { runOnBoot, runOnShutdown } from "./modules/lifecycle.js";
import { completeApp, createApp } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Process-level safety net: log unhandled rejections instead of
// terminating. The api has many async paths (wires, scheduler ticks,
// pg-pool reconnects); a stray rejection shouldn't take down the
// whole process. Real errors still surface via the per-pool 'error'
// listeners in db/meta.ts + db/tenant.ts.
process.on("unhandledRejection", (reason) => {
  console.error("[cobblr-api] unhandled rejection:", reason);
});

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
    tenants: {
      getDb: (orgId) => getTenantDb(orgId),
      releaseIdleDb: (orgId) => releaseIdleTenantPool(orgId),
    },
    db: { meta },
    entities: {
      registerResolver: entities.registerResolver,
      registerListResolver: entities.registerListResolver,
      registerComputedContext: computedFields.registerComputedContext,
      registerCreateDefaults: createDefaults.registerCreateDefaults,
      unregisterCreateDefaults: createDefaults.unregisterCreateDefaults,
      resolveCreateDefaults: createDefaults.resolveCreateDefaults,
      lookup: entities.lookup,
      lookupMany: entities.lookupMany,
      list: entities.list,
      walkPairings: entities.walkPairings,
      walkPath: entities.walkPath,
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
    health: {
      registerProbe: health.registerProbe,
      snapshot: health.snapshot,
    },
    recurrence: {
      registerScanner: recurrenceRegistry.registerScanner,
      listScanners: recurrenceRegistry.listScanners,
    },
    calendar: {
      registerSource: calendarRegistry.registerSource,
      collect: calendarRegistry.collect,
    },
    queue: {
      enqueue: queue.enqueue,
      registerWorker: queue.registerWorker,
      hasPendingJob: queue.hasPendingJob,
    },
    notifications: {
      dispatch: notificationsImpl.dispatch,
      orgMemberIds: async (orgId: string) => {
        const rows = await meta
          .selectFrom("org_memberships")
          .select("user_id")
          .where("org_id", "=", orgId)
          .execute();
        return rows.map((r) => String(r.user_id));
      },
    },
    integrations: {
      registerConnector: integrationsImpl.registerConnector,
      registerInboundHandler: integrationsImpl.registerInboundHandler,
      listConnectors: () =>
        integrationsImpl.listOutboundConnectors().map((c) => ({
          id: c.id,
          label: c.label,
          credentials: c.describeCredentials(),
          actions: c.actions,
        })),
      listInboundHandlers: () =>
        integrationsImpl.listInboundHandlers().map((h) => ({
          id: h.id,
          label: h.label,
          config: h.describeWebhookConfig(),
          emits: h.emits,
        })),
      getConnector: (id) => {
        const c = integrationsImpl.getConnector(id);
        if (!c) return null;
        return {
          id: c.id,
          label: c.label,
          actions: c.actions,
          testConnection: c.testConnection,
        };
      },
      encryptCredentials: integrationsImpl.encryptCredentials,
      decryptCredentials: integrationsImpl.decryptCredentials,
      invokeConnector: async (connectorId, ctx, actionId) => {
        const c = integrationsImpl.getConnector(connectorId);
        if (!c) throw new Error(`unknown connector: ${connectorId}`);
        return c.invoke(
          {
            orgId: ctx.orgId,
            connectorId,
            rowId: ctx.rowId,
            credentials: ctx.credentials,
            args: ctx.args ?? {},
            rendered: ctx.rendered,
            event: ctx.event,
          },
          actionId,
        );
      },
      dispatchInbound: async (handlerId, req, ctx) => {
        const h = integrationsImpl.getInboundHandler(handlerId);
        if (!h) throw new Error(`unknown inbound handler: ${handlerId}`);
        return h.handle(req, ctx);
      },
    },
    ai: {
      registerProvider: aiImpl.registerProvider,
      registerEntitlementGuard: aiImpl.registerEntitlementGuard,
      listProviders: aiImpl.listProviders,
      getProvider: aiImpl.getProvider,
      invoke: aiImpl.invoke,
    },
    files: {
      registerReader: files.registerReader,
      read: files.read,
    },
    instances: {
      registerItemCounter: instancesImpl.registerItemCounter,
    },
    auth: {
      // Capability check walks three sources in order:
      //   1. Stock role: owner/admin always pass.
      //   2. Direct per-user grant (workspace_capability_grants).
      //   3. Custom-role assignment that includes the capability.
      // See docs/modules/member-portal-and-permissions.md
      // §2.4 + 2026-05-25-audit.md S2.
      userHasCapability: async ({ orgId, userId, role, actionId }) => {
        if (role === "owner" || role === "admin") return true;
        // Direct grant.
        const grant = await meta
          .selectFrom("workspace_capability_grants")
          .select("id")
          .where("org_id", "=", orgId)
          .where("user_id", "=", userId)
          .where("action_id", "=", actionId)
          .executeTakeFirst();
        if (grant) return true;
        // Custom-role assignment → role's capability bundle.
        const viaRole = await meta
          .selectFrom("workspace_role_assignments as a")
          .innerJoin("workspace_role_capabilities as c", "c.role_id", "a.role_id")
          .select("c.action_id")
          .where("a.org_id", "=", orgId)
          .where("a.user_id", "=", userId)
          .where("c.action_id", "=", actionId)
          .limit(1)
          .executeTakeFirst();
        return !!viaRole;
      },
      mintAppToken: ({ userId, appSlug }) => signAppToken(userId, appSlug),
    },
    // B1 from 2026-05-25-audit.md: pairings + catalogs platform
    // surfaces so modules stop SELECTing each other's tables.
    pairings: {
      create: async ({ orgId, sourceKind, sourceId, targetKind, targetId, relationshipKind, createdBy }) => {
        const row = await meta
          .insertInto("entity_pairings")
          .values({
            org_id: orgId,
            source_kind: sourceKind,
            source_id: sourceId,
            target_kind: targetKind,
            target_id: targetId,
            relationship_kind: relationshipKind,
            created_by: createdBy ?? null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return { id: row.id };
      },
      createMany: async (rows) => {
        if (rows.length === 0) return { inserted: 0 };
        await meta
          .insertInto("entity_pairings")
          .values(
            rows.map((r) => ({
              org_id: r.orgId,
              source_kind: r.sourceKind,
              source_id: r.sourceId,
              target_kind: r.targetKind,
              target_id: r.targetId,
              relationship_kind: r.relationshipKind,
              created_by: r.createdBy ?? null,
            })),
          )
          .execute();
        return { inserted: rows.length };
      },
      findByTargets: async ({ orgId, sourceKind, targetKind, targetIds, relationshipKind }) => {
        if (targetIds.length === 0) return [];
        const rows = await meta
          .selectFrom("entity_pairings")
          .select(["source_id as sourceId", "target_id as targetId"])
          .where("org_id", "=", orgId)
          .where("source_kind", "=", sourceKind)
          .where("target_kind", "=", targetKind)
          .where("relationship_kind", "=", relationshipKind)
          .where("target_id", "in", targetIds)
          .execute();
        return rows;
      },
      findBySources: async ({ orgId, sourceKind, sourceIds, targetKind, relationshipKind }) => {
        if (sourceIds.length === 0) return [];
        const rows = await meta
          .selectFrom("entity_pairings")
          .select(["source_id as sourceId", "target_id as targetId"])
          .where("org_id", "=", orgId)
          .where("source_kind", "=", sourceKind)
          .where("target_kind", "=", targetKind)
          .where("relationship_kind", "=", relationshipKind)
          .where("source_id", "in", sourceIds)
          .execute();
        return rows;
      },
    },
    catalogs: {
      findBySemanticType: async (orgId, semanticType) => {
        type CatalogsXReadDB = {
          core_catalogs_catalogs: {
            id: string;
            name: string;
            schema: Record<string, unknown>;
          };
        };
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<CatalogsXReadDB>;
        const row = await tdb
          .selectFrom("core_catalogs_catalogs")
          .select(["id", "name", "schema"])
          .where(sql<boolean>`schema->>'semantic_type' = ${semanticType}`)
          .limit(1)
          .executeTakeFirst();
        return row ? { id: row.id, name: row.name, schema: row.schema ?? {} } : null;
      },
      findByBundleExternalIdSuffix: async (orgId, suffix) => {
        type CatalogsXReadDB = {
          core_catalogs_catalogs: {
            id: string;
            name: string;
            bundle_external_id: string | null;
          };
        };
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<CatalogsXReadDB>;
        const row = await tdb
          .selectFrom("core_catalogs_catalogs")
          .select(["id", "name"])
          .where("bundle_external_id", "like", `%${suffix}`)
          .limit(1)
          .executeTakeFirst();
        return row ? { id: row.id, name: row.name } : null;
      },
      queryEntries: async ({ orgId, catalogId, payloadEq, externalIdIn, limit }) => {
        type CatalogsXReadDB = {
          core_catalogs_entries: {
            id: string;
            catalog_id: string;
            external_id: string;
            payload: Record<string, unknown>;
          };
        };
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<CatalogsXReadDB>;
        let q = tdb
          .selectFrom("core_catalogs_entries")
          .select(["id", "catalog_id", "external_id", "payload"])
          .where("catalog_id", "=", catalogId);
        if (payloadEq) {
          for (const [k, v] of Object.entries(payloadEq)) {
            q = q.where(sql<boolean>`payload->>${k} = ${v}`);
          }
        }
        if (externalIdIn && externalIdIn.length > 0) {
          q = q.where("external_id", "in", externalIdIn);
        }
        if (limit) q = q.limit(limit);
        const rows = await q.execute();
        return rows.map((r) => ({
          id: r.id,
          catalogId: r.catalog_id,
          externalId: r.external_id,
          payload: r.payload as Record<string, unknown>,
        }));
      },
      similaritySearch: async ({ orgId, catalogId, queryText, payloadKey, limit }) => {
        // pg_trgm similarity against payload->>'<key>'. The key
        // defaults to "name" because that's the conventional
        // user-facing identifier across the catalogs we ship;
        // callers can override (e.g. payload->>'title' for a
        // future media catalog). Limit hard-capped at 100 so a
        // misuse can't drag a 100k-row catalog through pg_trgm.
        const k = Math.max(1, Math.min(limit ?? 10, 100));
        const key = payloadKey ?? "name";
        type CatalogsXReadDB = {
          core_catalogs_entries: {
            id: string;
            external_id: string;
            payload: Record<string, unknown>;
          };
        };
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<CatalogsXReadDB>;
        const compiled = sql<{
          id: string;
          external_id: string;
          payload: Record<string, unknown>;
          score: number;
        }>`
          select
            id,
            external_id,
            payload,
            similarity(payload->>${key}, ${queryText}) as score
          from core_catalogs_entries
          where catalog_id = ${catalogId}
            and payload->>${key} is not null
          order by similarity(payload->>${key}, ${queryText}) desc
          limit ${k}
        `.compile(tdb as never);
        const result = await (
          tdb as unknown as {
            executeQuery: (
              q: unknown,
            ) => Promise<{
              rows: Array<{
                id: string;
                external_id: string;
                payload: Record<string, unknown>;
                score: number;
              }>;
            }>;
          }
        ).executeQuery(compiled);
        return result.rows.map((r) => ({
          id: r.id,
          externalId: r.external_id,
          payload: r.payload,
          score: Number(r.score),
        }));
      },
    },
  });

  await loadAllModules();
  // Marketplace v0.3 PoC: register sandboxed wasm modules alongside
  // the in-process modules. They get the same Express mount + the
  // same workspace-enable toggle; the difference is invisible to
  // everything except the route handler (which goes through the
  // wasm sandbox). See docs/architecture/module-isolation.md.
  await loadAllSandboxedModules();
  // Mirror manifests into the cobblr_meta registries after load so
  // <EntityActionsBar> / platform.entities.lookup() etc. have
  // accurate metadata. Done AFTER load so module-side resolver /
  // handler registrations land first.
  await syncManifestRegistries();
  // Marketplace v2: snapshot the runtime module set into
  // installed_modules so super-admin / workspace-admin can see what
  // code is present + version + signature. See
  // docs/modules/marketplace.md §4.
  const installedCount = await syncInstalledModules();
  console.log(`[cobblr-api] installed_modules synced: ${installedCount}`);
  // One-shot: convert the four legacy Pillar-E lens modules
  // (3d-printers, laser-cutters, cnc-machines, workshop-mods) to
  // equivalent bundles. They used to be pure-field-def modules; now
  // they're lens bundles with `provides_lens`. Idempotent — orgs
  // that have already been migrated (or never had the modules
  // enabled) skip silently. Runs BEFORE syncTenantMigrations so
  // any cleaned-up org_modules rows don't get a stale migration
  // sync.
  const lensResult = await migrateLensModules();
  if (lensResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] lens-module → bundle migration: ${lensResult.orgsTouched} org(s), ${lensResult.bundlesInstalled} bundle(s) installed, ${lensResult.fieldsMoved} field def(s) moved`,
    );
  }
  // One-shot: move inventory_locations rows into core_locations_locations
  // (UUIDs preserved so cross-module location_id refs stay valid) and
  // drop the inventory_parts.location_id FK constraint that pinned the
  // table to inventory. Idempotent — orgs already migrated no-op.
  // Runs BEFORE syncTenantMigrations so the org_modules row we may
  // insert for core-locations doesn't get a stale migration sync.
  const invLocResult = await migrateInventoryLocations();
  if (invLocResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] inventory_locations → core-locations: ${invLocResult.orgsTouched} org(s), ${invLocResult.rowsCopied} row(s) copied, ${invLocResult.fksDropped} FK(s) dropped`,
    );
  }
  // Catch every (org, module) up to the latest module migration. A
  // module that ships a new migration after an org enabled it won't
  // pick it up otherwise — enableModuleForOrg short-circuits on the
  // existing org_modules row. Idempotent: tenants already current
  // run zero queries.
  const touched = await syncTenantMigrations();
  if (touched > 0) {
    console.log(`[cobblr-api] tenant migrations: ${touched} tenant(s) caught up`);
  }
  // Top up default bindings for orgs created before Phase 4 introduced
  // the seed-on-signup path. Idempotent per (org, source_kind, action_id,
  // trigger_event), so repeated boots are safe.
  const seeded = await backfillDefaultBindings();
  console.log(`[cobblr-api] default bindings backfilled: ${seeded} added`);

  const { app } = createApp();
  await mountModules(app);
  completeApp(app);

  // Module-owned background work — core-recurrence starts its
  // scheduler here, future modules (core-queue, etc.) get their
  // chance too. Errors per-module are logged + skipped so a stuck
  // hook can't block boot.
  await runOnBoot();

  // Platform-owned calendar source: any date custom-field on the core
  // entity kinds shows up on the workspace calendar automatically.
  registerDateFieldCalendarSources();

  // Platform-owned background work — the queue worker loop. Started
  // AFTER onBoot so modules have had a chance to register their
  // queue handlers via platform.queue.registerWorker().
  queue.startWorker();

  const server = app.listen(env.API_PORT, () => {
    console.log(`[cobblr-api] listening on :${env.API_PORT} (${env.NODE_ENV})`);
  });

  function shutdown(signal: string) {
    console.log(`[cobblr-api] ${signal} received, draining`);
    // Stop the queue worker first so no new jobs are claimed during
    // shutdown. In-flight jobs finish their current iteration; the
    // stale-lock sweep on the next process's boot reclaims any that
    // didn't get a chance to mark themselves done/failed.
    queue.stopWorker();
    // Fire-and-forget the module-side shutdown — runOnShutdown
    // itself is per-hook timeout-bounded so it can't hang the
    // outer 10s budget below.
    void runOnShutdown();
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
