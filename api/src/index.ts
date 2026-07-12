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
import { setPlatform, canContain, canBeContained } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import { env } from "./env.js";
import { meta, metaPool, pingMeta } from "./db/meta.js";
import { runMigrations } from "./db/migrate.js";
import { getTenantDb, releaseIdleTenantPool } from "./db/tenant.js";
import { bakeTestOrgPool, poolEnabled } from "./db/test-org-pool.js";
import { signAppToken, signSession } from "./auth/jwt.js";
import { loadAllModules } from "./modules/loader.js";
import { loadAllSandboxedModules } from "./sandbox/loader.js";
import { syncTenantMigrations, reconcileDefaultModules } from "./modules/enable.js";
import { mountModules } from "./modules/mount.js";
import * as activity from "./platform/activity.js";
import * as actions from "./platform/actions.js";
import * as devices from "./platform/devices.js";
import * as entities from "./platform/entities.js";
import * as files from "./platform/files.js";
import * as hostedSeams from "./platform/hosted-seams.js";
import { registerConfiguredAuthEmailSender } from "./platform/auth-email-config.js";
import * as events from "./platform/events.js";
import * as templates from "./platform/templates.js";
import * as wires from "./platform/wires.js";
import * as health from "./platform/health.js";
import * as recurrenceRegistry from "./platform/recurrence-registry.js";
import * as calendarRegistry from "./platform/calendar-registry.js";
import { registerDateFieldSource, queryDateField } from "./platform/date-field-calendar.js";
import { registerDefaultRequestGuard } from "./platform/default-request-guard.js";
import * as computedFields from "./platform/computed-fields.js";
import * as createDefaults from "./platform/create-defaults.js";
import * as deviceApply from "./platform/device-apply.js";
import * as scanRegistry from "./platform/scan-registry.js";
import * as unitsImpl from "./platform/units.js";
import * as instancesImpl from "./platform/instances.js";
import * as scanResolvers from "./platform/scan-resolvers.js";
import * as queue from "./platform/queue.js";
import * as sharedCache from "./platform/shared-cache.js";
import * as notificationsImpl from "./platform/notifications.js";
import * as integrationsImpl from "./platform/integrations.js";
import * as aiImpl from "./platform/ai.js";
import * as edgeImpl from "./platform/edge.js";
import * as egressImpl from "./platform/egress.js";
import { syncManifestRegistries } from "./platform/registry-sync.js";
import { syncInstalledModules } from "./platform/installed-modules.js";
import { migrateLensModules } from "./platform/migrate-lens-modules.js";
import { migrateLensBundlesToInstances } from "./platform/migrate-lens-bundles-to-instances.js";
import { enableDigifabForMachineBundles } from "./platform/enable-digifab-for-machines.js";
import { migrateInventoryLocations } from "./platform/migrate-inventory-locations.js";
import { backfillPlacements } from "./platform/migrate-location-to-placement.js";
import { backfillDefaultBindings } from "./platform/seed-bindings.js";
import { backfillBundleClaims } from "./platform/backfill-bundle-claims.js";
import {
  registerDeclarativeScanResolver,
  refreshScanUrlManifests,
} from "./platform/scan-url-resolvers/register.js";
import { runOnBoot, runOnShutdown } from "./modules/lifecycle.js";
import { registerBackupCron, seedBackupSchedules } from "./platform/backup-destinations.js";
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

// The per-tenant DB slice platform().placement touches. The table is owned by
// the core-placement foundational module (tenant-local — no org_id; the tenant
// DB is the org). getTenantDb(orgId) is cast to this.
type PlacementDB = {
  core_placement_placements: {
    containee_kind: string;
    containee_id: string;
    container_kind: string;
    container_id: string;
    slot: string | null;
    placed_by: string | null;
    placed_at: unknown;
  };
};

async function boot() {
  // Boot-phase profiler: logs `[bootphase] <label>: <ms>` per pass so we can see
  // exactly what the pre-`listen` sequence spends against a big (CI org-pool)
  // meta. Cheap (one Date.now + log per phase); left in permanently — the numbers
  // are only interesting when boot is slow, and it's the map for any future cut.
  const bootT0 = Date.now();
  const T = async <R>(label: string, p: Promise<R>): Promise<R> => {
    const t = Date.now();
    const r = await p;
    console.log(`[bootphase] ${label}: ${Date.now() - t}ms`);
    return r;
  };
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
      registerWriter: entities.registerEntityWriter,
      getWriter: (kind) => entities.getEntityWriter(kind) ?? null,
      registerListResolver: entities.registerListResolver,
      registerInstanceListResolver: entities.registerInstanceListResolver,
      registerInstanceResolver: entities.registerInstanceResolver,
      registerComputedContext: computedFields.registerComputedContext,
      registerCreateDefaults: createDefaults.registerCreateDefaults,
      unregisterCreateDefaults: createDefaults.unregisterCreateDefaults,
      resolveCreateDefaults: createDefaults.resolveCreateDefaults,
      registerDeviceApply: deviceApply.registerDeviceApply,
      applyDevice: deviceApply.applyDevice,
      registerScannable: scanRegistry.registerScannable,
      getScannable: scanRegistry.getScannable,
      listScannable: scanRegistry.listScannable,
      lookup: entities.lookup,
      lookupMany: entities.lookupMany,
      list: entities.list,
      walkPairings: entities.walkPairings,
      walkPath: entities.walkPath,
      listKinds: entities.listKinds,
      listKindsForOrg: entities.listKindsForOrg,
      getKind: entities.getKind,
      serverManagedFields: entities.serverManagedFields,
    },
    actions: {
      registerHandler: actions.registerHandler,
      listApplicable: actions.listApplicable,
      invoke: actions.invoke,
    },
    devices: {
      registerDriverProvider: devices.registerDriverProvider,
      getDriver: devices.getDriver,
      registerConnectionStore: devices.registerConnectionStore,
      connections: devices.connections,
    },
    templates: { render: templates.render },
    units: {
      registerService: unitsImpl.registerService,
      resolve: unitsImpl.resolve,
      convert: unitsImpl.convert,
    },
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
      registerDateFieldSource,
      collect: calendarRegistry.collect,
      queryDateField,
    },
    queue: {
      enqueue: queue.enqueue,
      registerWorker: queue.registerWorker,
      hasPendingJob: queue.hasPendingJob,
    },
    sharedCache: {
      get: sharedCache.get,
      put: sharedCache.put,
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
      registerSyncConnector: integrationsImpl.registerSyncConnector,
      getSyncConnector: (id) => integrationsImpl.getSyncConnector(id) ?? null,
      listSyncConnectors: () =>
        integrationsImpl.listSyncConnectors().map((c) => ({
          id: c.id,
          label: c.label,
          credentials: c.describeCredentials(),
          config: c.describeConfig?.() ?? {},
          entityTypes: c.entityTypes.map((t) => ({ key: t.key, label: t.label, targetKind: t.targetKind })),
        })),
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
      getEndpointPolicy: aiImpl.getEndpointPolicy,
      setEndpointPolicy: aiImpl.setEndpointPolicy,
      listProviders: aiImpl.listProviders,
      getProvider: aiImpl.getProvider,
      invoke: aiImpl.invoke,
    },
    edge: {
      registerChannel: edgeImpl.registerChannel,
      hasChannel: edgeImpl.hasChannel,
      send: edgeImpl.send,
      relayTouch: edgeImpl.relayTouch,
      relayPoll: edgeImpl.relayPoll,
      relayRespond: edgeImpl.relayRespond,
      relayAgents: edgeImpl.relayAgents,
      relayInfo: edgeImpl.relayInfo,
      registerConsumer: edgeImpl.registerConsumer,
      listConsumers: edgeImpl.listConsumers,
      getRelease: edgeImpl.getRelease,
      getReleaseBundle: edgeImpl.getReleaseBundle,
      getReleaseLoader: edgeImpl.getReleaseLoader,
    },
    egress: {
      guardedFetch: egressImpl.guardedFetch,
      registerAllow: egressImpl.registerAllow,
    },
    files: {
      registerReader: files.registerReader,
      read: files.read,
      registerWriter: files.registerWriter,
      write: files.write,
      registerDriver: files.registerDriver,
      getDriver: files.getDriver,
    },
    instances: {
      registerItemCounter: instancesImpl.registerItemCounter,
      list: async (orgId: string) => {
        const rows = await instancesImpl.listInstances(orgId);
        return Promise.all(
          rows.map(async (r) => ({
            module_name: r.module_name,
            instance_name: r.instance_name,
            display_name: r.display_name,
            is_default: r.is_default,
            item_count: await instancesImpl.countInstanceItems(
              orgId,
              r.module_name,
              r.instance_name,
            ),
          })),
        );
      },
    },
    scan: {
      registerUrlResolver: scanResolvers.registerScanUrlResolver,
      resolveUrl: scanResolvers.resolveScanUrl,
    },
    // Hosted-overlay extension seams — no-op / allow-all in open core.
    entitlements: {
      registerGuard: hostedSeams.registerEntitlementGuard,
      check: hostedSeams.checkEntitlement,
    },
    metering: {
      registerSink: hostedSeams.registerMeterSink,
      record: hostedSeams.meter,
    },
    accounts: {
      registerLifecycleHooks: hostedSeams.registerLifecycleHooks,
    },
    http: {
      registerRequestGuard: hostedSeams.registerRequestGuard,
      registerWebhook: hostedSeams.registerWebhook,
    },
    hostedPanels: {
      register: hostedSeams.registerHostedPanel,
      list: hostedSeams.listHostedPanels,
      get: hostedSeams.getHostedPanel,
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
      mintSession: ({ userId }) => signSession(userId),
      registerEmailSender: hostedSeams.registerAuthEmailSender,
      hasEmailSender: hostedSeams.hasAuthEmailSender,
      sendEmail: hostedSeams.sendAuthEmail,
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
    // Placement — the containment primitive. "A containee lives inside a
    // container." One relationship for the whole platform (a part in a machine,
    // a component in a server, an item in a location); see
    // docs/design-decisions/placement-and-containment.md.
    placement: {
      place: async ({ orgId, containee, container, slot, placedBy }) => {
        if (containee.kind === container.kind && containee.id === container.id) {
          throw new Error("placement: an entity cannot contain itself");
        }
        // Trait gate: only a physical thing can contain; only a containable
        // thing can be contained. Unknown kinds (not in the registry) are left
        // to the caller — we don't block a custom kind we can't classify.
        const [cteeKind, ctnrKind] = await Promise.all([
          entities.getKind(containee.kind),
          entities.getKind(container.kind),
        ]);
        if (ctnrKind && !canContain(ctnrKind.traits as Record<string, unknown> | null)) {
          throw new Error(`placement: ${container.kind} cannot contain (not a physical container)`);
        }
        if (cteeKind && !canBeContained(cteeKind.traits as Record<string, unknown> | null)) {
          throw new Error(`placement: ${containee.kind} cannot be contained`);
        }
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        // Cycle guard: walk up the container's placement chain (same tenant DB);
        // reaching the containee means this placement would form a loop.
        let cursor: { kind: string; id: string } | null = { kind: container.kind, id: container.id };
        const seen = new Set<string>();
        while (cursor) {
          if (cursor.kind === containee.kind && cursor.id === containee.id) {
            throw new Error("placement: would create a containment cycle");
          }
          const key = `${cursor.kind} ${cursor.id}`;
          if (seen.has(key)) break; // defensive — pre-existing cycle, don't spin
          seen.add(key);
          const up = await tdb
            .selectFrom("core_placement_placements")
            .select(["container_kind", "container_id"])
            .where("containee_kind", "=", cursor.kind)
            .where("containee_id", "=", cursor.id)
            .executeTakeFirst();
          cursor = up ? { kind: up.container_kind, id: up.container_id } : null;
        }
        // Upsert — one container per containee (moving re-points the same row).
        await tdb
          .insertInto("core_placement_placements")
          .values({
            containee_kind: containee.kind,
            containee_id: containee.id,
            container_kind: container.kind,
            container_id: container.id,
            slot: slot ?? null,
            placed_by: placedBy ?? null,
          })
          .onConflict((oc) =>
            oc.columns(["containee_kind", "containee_id"]).doUpdateSet({
              container_kind: container.kind,
              container_id: container.id,
              slot: slot ?? null,
              placed_by: placedBy ?? null,
              placed_at: sql`now()`,
            }),
          )
          .execute();
        // ONE truth during the transition: keep the containee's legacy
        // location_id coherent with the placement, via the module's own entity
        // writer (the isolation-respecting cross-module write seam).
        //   into a location        → location_id = that location
        //   into an entity (server/machine) → location_id = null (it left the shelf;
        //     without this, lists kept showing the old shelf while the item was
        //     inside a container — two disagreeing answers)
        // Best-effort: kinds without a writer (custom kinds) skip the sync.
        try {
          const writer = entities.getEntityWriter(containee.kind);
          if (writer) {
            const loc = container.kind === "core-locations:location" ? container.id : null;
            await writer.update(orgId, containee.id, { location_id: loc });
          }
        } catch (err) {
          console.warn(
            `[placement] location_id sync for ${containee.kind} skipped:`,
            (err as Error).message,
          );
        }
      },
      remove: async ({ orgId, containee }) => {
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        // If the containee was in a LOCATION container, clear the legacy
        // location_id too — otherwise the sync trigger resurrects the placement
        // on the next incidental update of that row.
        const prev = await tdb
          .selectFrom("core_placement_placements")
          .select(["container_kind"])
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .executeTakeFirst();
        await tdb
          .deleteFrom("core_placement_placements")
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .execute();
        if (prev?.container_kind === "core-locations:location") {
          try {
            const writer = entities.getEntityWriter(containee.kind);
            if (writer) await writer.update(orgId, containee.id, { location_id: null });
          } catch (err) {
            console.warn(
              `[placement] location_id clear for ${containee.kind} skipped:`,
              (err as Error).message,
            );
          }
        }
      },
      containerOf: async ({ orgId, containee }) => {
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const row = await tdb
          .selectFrom("core_placement_placements")
          .select(["container_kind", "container_id"])
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .executeTakeFirst();
        return row ? { kind: row.container_kind, id: row.container_id } : null;
      },
      contents: async ({ orgId, container }) => {
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const rows = await tdb
          .selectFrom("core_placement_placements")
          .select(["containee_kind", "containee_id"])
          .where("container_kind", "=", container.kind)
          .where("container_id", "=", container.id)
          .execute();
        return rows.map((r) => ({ kind: r.containee_kind, id: r.containee_id }));
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
        // HOSTED ROUTING: when a catalog's rows live in the shared reference
        // service (source='hosted'), resolve from it instead of the empty tenant
        // table. Today the routed read is the Lego BOM by set_num (disassemble);
        // other hosted reads fall through. Tightly gated — only fires for a
        // hosted catalog (none until a workspace opts in), so the local path
        // below is unchanged. See docs/architecture/shared-reference-catalogs.md.
        const catResolver = (process.env.COBBLR_CATALOG_RESOLVER_URL ?? "").replace(/\/+$/, "");
        if (catResolver && payloadEq?.set_num) {
          const meta = (
            await sql<{ source: string | null; semantic_type: string | null }>`
              select source, schema->>'semantic_type' as semantic_type
                from core_catalogs_catalogs where id = ${catalogId} limit 1
            `.execute(tdb as never)
          ).rows[0];
          if (meta?.source === "hosted" && meta.semantic_type === "lego.bom") {
            try {
              const url = `${catResolver}/bom?dataset=rebrickable&set_num=${encodeURIComponent(payloadEq.set_num)}`;
              const res = await egressImpl.guardedFetch(orgId, url, {
                headers: { Authorization: `Bearer ${process.env.COBBLR_CATALOG_RESOLVER_TOKEN ?? ""}` },
              });
              if (res.ok) {
                const body = (await res.json()) as {
                  parts?: Array<{
                    part_num: string;
                    color_id?: number | string | null;
                    quantity?: number;
                    is_spare?: boolean;
                    image?: string | null;
                    name?: string;
                    category?: string | null;
                  }>;
                };
                const rows = (body.parts ?? []).map((p) => {
                  const rowId = `${payloadEq.set_num}-${p.part_num}-${p.color_id ?? ""}-${p.is_spare ? "t" : "f"}`;
                  return {
                    id: rowId,
                    catalogId,
                    externalId: rowId,
                    // The hosted /bom is already fully hydrated (name + category
                    // + image), so a hosted disassemble reads these straight from
                    // the BOM row — no separate parts/part-category lookups, which
                    // would hit the (empty) hosted parts catalog.
                    payload: {
                      set_num: payloadEq.set_num,
                      part_num: p.part_num,
                      color_id: p.color_id == null ? "" : String(p.color_id),
                      quantity: p.quantity ?? 1,
                      is_spare: p.is_spare ?? false,
                      img_url: p.image ?? "",
                      name: p.name,
                      category: p.category ?? undefined,
                    } as Record<string, unknown>,
                  };
                });
                return limit ? rows.slice(0, limit) : rows;
              }
            } catch {
              /* resolver unreachable → fall through to the local table */
            }
          }
        }
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

  // Self-hoster BYO auth-email sender (env-configured SMTP / Mailgun / Resend /
  // Postmark). Registered BEFORE module load so the cloud overlay's managed
  // sender, registered in its onBoot, wins via last-registration when present.
  registerConfiguredAuthEmailSender();

  await T("loadAllModules", loadAllModules());
  // Marketplace v0.3 PoC: register sandboxed wasm modules alongside
  // the in-process modules. They get the same Express mount + the
  // same workspace-enable toggle; the difference is invisible to
  // everything except the route handler (which goes through the
  // wasm sandbox). See docs/architecture/module-isolation.md.
  await T("loadAllSandboxedModules", loadAllSandboxedModules());
  // Mirror manifests into the cobblr_meta registries after load so
  // <EntityActionsBar> / platform.entities.lookup() etc. have
  // accurate metadata. Done AFTER load so module-side resolver /
  // handler registrations land first.
  await T("syncManifestRegistries", syncManifestRegistries());
  // Register the single generic vendor scan-URL resolver (built-in manifests like
  // Polar + operator-added rows). Replaces the old per-vendor maker-scan module.
  // The DB rows are loaded by refreshScanUrlManifests() after migrations below.
  registerDeclarativeScanResolver();
  // Marketplace v2: snapshot the runtime module set into
  // installed_modules so super-admin / workspace-admin can see what
  // code is present + version + signature. See
  // docs/modules/marketplace.md §4.
  const installedCount = await T("syncInstalledModules", syncInstalledModules());
  console.log(`[cobblr-api] installed_modules synced: ${installedCount}`);
  // One-shot: convert the four legacy Pillar-E lens modules
  // (3d-printers, laser-cutters, cnc-machines, workshop-mods) to
  // equivalent bundles. They used to be pure-field-def modules; now
  // they're lens bundles with `provides_lens`. Idempotent — orgs
  // that have already been migrated (or never had the modules
  // enabled) skip silently. Runs BEFORE syncTenantMigrations so
  // any cleaned-up org_modules rows don't get a stale migration
  // sync.
  const lensResult = await T("migrateLensModules", migrateLensModules());
  if (lensResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] lens-module → bundle migration: ${lensResult.orgsTouched} org(s), ${lensResult.bundlesInstalled} bundle(s) installed, ${lensResult.fieldsMoved} field def(s) moved`,
    );
  }
  // Second-generation: convert still-lens-shaped machine bundles (provides_lens)
  // into the instance shape (provides_instances) — provision the tab, re-key
  // field defs to <name>:item, move existing machines into the instance, enable
  // digifab. Self-heals the "Machines everywhere" state with no user reinstall.
  // Runs AFTER migrate-lens-modules so it catches bundles it just created.
  const lensInstResult = await T("migrateLensBundlesToInstances", migrateLensBundlesToInstances());
  if (lensInstResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] lens-bundle → instance migration: ${lensInstResult.orgsTouched} org(s), ${lensInstResult.bundlesMigrated} bundle(s) converted, ${lensInstResult.machinesMoved} machine(s) moved`,
    );
  }
  // Enable digifab (Print Manager) for machine-bundle orgs that predate the
  // default-on "Connect to your machines" feature — so a printer can actually be
  // connected without the user hunting in Configuration. Additive + idempotent.
  const digifabResult = await T("enableDigifabForMachineBundles", enableDigifabForMachineBundles());
  if (digifabResult.orgsEnabled > 0) {
    console.log(`[cobblr-api] enabled digifab for ${digifabResult.orgsEnabled} machine-bundle org(s)`);
  }
  // One-shot: move inventory_locations rows into core_locations_locations
  // (UUIDs preserved so cross-module location_id refs stay valid) and
  // drop the inventory_parts.location_id FK constraint that pinned the
  // table to inventory. Idempotent — orgs already migrated no-op.
  // Runs BEFORE syncTenantMigrations so the org_modules row we may
  // insert for core-locations doesn't get a stale migration sync.
  const invLocResult = await T("migrateInventoryLocations", migrateInventoryLocations());
  if (invLocResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] inventory_locations → core-locations: ${invLocResult.orgsTouched} org(s), ${invLocResult.rowsCopied} row(s) copied, ${invLocResult.fksDropped} FK(s) dropped`,
    );
  }
  // Seed the placement primitive from existing location_id values (a Location is
  // one KIND of container). Runs after locations are canonical + before
  // syncTenantMigrations, same as above. Idempotent; the dual-write keeps it
  // fresh once it ships (step 2b).
  const placeResult = await T("backfillPlacements", backfillPlacements());
  if (placeResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] location_id → placement backfill: ${placeResult.orgsTouched} org(s), ${placeResult.rowsInserted} placement row(s) seeded`,
    );
  }
  // Self-heal: backfill foundational + autoEnable capabilities onto workspaces
  // that predate them. Signup only enables what existed then, so an older
  // workspace is missing newer capabilities' tables (e.g. core-devices owns
  // `core_devices_connections`) and 500s on any op that touches them. Runs
  // BEFORE syncTenantMigrations so a freshly-enabled module's row is caught up.
  // Idempotent: complete orgs cost one in-memory check and open no tenant pool.
  const reconciled = await T("reconcileDefaultModules", reconcileDefaultModules());
  if (reconciled.orgsHealed > 0) {
    console.log(`[cobblr-api] default-module reconcile: ${reconciled.orgsHealed} workspace(s) healed, ${reconciled.modulesAdded} module(s) enabled`);
  }
  // Catch every (org, module) up to the latest module migration. A
  // module that ships a new migration after an org enabled it won't
  // pick it up otherwise — enableModuleForOrg short-circuits on the
  // existing org_modules row. Idempotent: tenants already current
  // run zero queries.
  const syncStart = Date.now();
  const touched = await syncTenantMigrations();
  // Always log the duration (not just when work happened): this pass sweeps
  // every tenant, so with the CI org-pool (~250 orgs) it's the boot hot spot —
  // the number is what we watch after parallelising it.
  console.log(
    `[cobblr-api] tenant migration sync: ${touched} tenant(s) caught up in ${Date.now() - syncStart}ms`,
  );
  // Load operator-added vendor scan-URL resolvers now the table exists (migration
  // 069 ran above). Built-ins work without this; this folds in DB rows/overrides.
  await T("refreshScanUrlManifests", refreshScanUrlManifests());
  // Top up default bindings for orgs created before Phase 4 introduced
  // the seed-on-signup path. Idempotent per (org, source_kind, action_id,
  // trigger_event), so repeated boots are safe.
  const seeded = await T("backfillDefaultBindings", backfillDefaultBindings());
  console.log(`[cobblr-api] default bindings backfilled: ${seeded} added`);

  // Self-heal the bundle-resource-claims ledger for installs that predate it,
  // so a bundle uninstall can refcount correctly. Once per org, idempotent.
  const claimsOrgs = await T("backfillBundleClaims", backfillBundleClaims());
  if (claimsOrgs > 0) {
    console.log(`[cobblr-api] bundle-resource claims backfilled for ${claimsOrgs} org(s)`);
  }

  console.log(`[bootphase] === pre-createApp total: ${Date.now() - bootT0}ms ===`);
  const { app } = createApp();
  await T("mountModules", mountModules(app));
  completeApp(app);

  // Module-owned background work — core-recurrence starts its
  // scheduler here, future modules (core-queue, etc.) get their
  // chance too. Errors per-module are logged + skipped so a stuck
  // hook can't block boot.
  await T("runOnBoot", runOnBoot());

  // Abuse rate-limiting. Registered AFTER onBoot so a hosted overlay that
  // registers its own (distributed) guard takes precedence; this in-core
  // in-memory limiter only kicks in when nothing else did — so a public
  // deploy without the overlay still has brute-force protection on auth /
  // anonymous / feedback surfaces. See 2026-06-10 pre-launch audit #1.
  if (registerDefaultRequestGuard()) {
    console.log("[cobblr-api] in-core rate-limit guard active (auth/anon/feedback)");
  }

  // (The date-custom-field calendar source is now registered per-owning-module
  // via platform().calendar.registerDateFieldSource — inventory/assets/projects
  // each opt in at their own boot, so the kernel no longer hardcodes them.)

  // Scheduled backups (Blueprint/Backup/Export Phase C) — register the
  // per-destination cron worker, then re-arm any due schedules. Before
  // startWorker so the handler is in place when the loop begins.
  registerBackupCron();

  // Platform-owned background work — the queue worker loop. Started
  // AFTER onBoot so modules have had a chance to register their
  // queue handlers via platform.queue.registerWorker().
  queue.startWorker();

  void seedBackupSchedules().catch((err) =>
    console.error("[backup-cron] seed schedules failed:", (err as Error).message),
  );

  console.log(`[bootphase] === boot total (to listen): ${Date.now() - bootT0}ms ===`);
  const server = app.listen(env.API_PORT, () => {
    console.log(`[cobblr-api] listening on :${env.API_PORT} (${env.NODE_ENV})`);
  });

  // TEST-ONLY: fill the pre-provisioned org pool AFTER listen (so /healthz is
  // fast) and in the background — CI polls /test-support/pool-status before
  // starting the suite. No-op unless COBBLR_TEST_ORG_POOL is set (prod never
  // sets it). The offline image/tarball bake makes this a fast no-op (pool
  // already full); the boot bake is the in-job / PoC path.
  if (poolEnabled() && env.COBBLR_TEST_ORG_POOL_SIZE) {
    const target = env.COBBLR_TEST_ORG_POOL_SIZE;
    void bakeTestOrgPool(target)
      .then((r) => console.log(`[test-org-pool] boot bake done: ${r.total} orgs ready`))
      .catch((err) => console.error("[test-org-pool] boot bake failed:", (err as Error).message));
  }

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
