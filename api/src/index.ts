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
import { withFieldLabels } from "./platform/field-labels.js";
import { dirname, resolve } from "node:path";
import { setPlatform, canContain, canBeContained } from "@cobblr/platform-contract";
import { resolveFieldDefsForKind } from "./platform/field-defs.js";
import { sql, type Kysely } from "kysely";
import { env } from "./env.js";
import { meta, metaPool, pingMeta } from "./db/meta.js";
import { runMigrations } from "./db/migrate.js";
import { getTenantDb, releaseIdleTenantPool, withTenantDbForSweep } from "./db/tenant.js";
import { bakeTestOrgPool, poolEnabled } from "./db/test-org-pool.js";
import { signAppToken, signSession } from "./auth/jwt.js";
import { loadAllModules } from "./modules/loader.js";
import { loadAllSandboxedModules } from "./sandbox/loader.js";
import { syncTenantMigrations, reconcileDefaultModules } from "./modules/enable.js";
import { mountModules } from "./modules/mount.js";
import { registerBuiltinResolvables } from "./platform/resolvable-providers.js";
import { registerResolvable, resolveValue } from "./platform/resolvables.js";
import * as activity from "./platform/activity.js";
import * as actions from "./platform/actions.js";
import * as live from "./platform/live.js";
import * as devices from "./platform/devices.js";
import * as entities from "./platform/entities.js";
import * as files from "./platform/files.js";
import * as hostedSeams from "./platform/hosted-seams.js";
import { registerConfiguredAuthEmailSender } from "./platform/auth-email-config.js";
import * as events from "./platform/events.js";
import * as connectionsImpl from "./platform/connections.js";
import * as templates from "./platform/templates.js";
import * as wires from "./platform/wires.js";
import * as health from "./platform/health.js";
import * as recurrenceRegistry from "./platform/recurrence-registry.js";
import * as calendarRegistry from "./platform/calendar-registry.js";
import { registerDateFieldSource, queryDateField } from "./platform/date-field-calendar.js";
import { registerDefaultRequestGuard } from "./platform/default-request-guard.js";
import { registerTrialMode } from "./platform/trial.js";
import * as computedFields from "./platform/computed-fields.js";
import * as createDefaults from "./platform/create-defaults.js";
import * as deviceApply from "./platform/device-apply.js";
import * as scanRegistry from "./platform/scan-registry.js";
import * as unitsImpl from "./platform/units.js";
import * as instancesImpl from "./platform/instances.js";
import { registerMover } from "./platform/move-records.js";
import * as scanResolvers from "./platform/scan-resolvers.js";
import * as queue from "./platform/queue.js";
import * as sharedCache from "./platform/shared-cache.js";
import * as notificationsImpl from "./platform/notifications.js";
import * as integrationsImpl from "./platform/integrations.js";
import * as aiImpl from "./platform/ai.js";
import * as edgeImpl from "./platform/edge.js";
import * as egressImpl from "./platform/egress.js";
import { syncManifestRegistries } from "./platform/registry-sync.js";
import { registerPlatformActionHandlers } from "./platform/platform-action-handlers.js";
import { registerHostedMcp } from "./platform/hosted-mcp.js";
import { syncInstalledModules } from "./platform/installed-modules.js";
import { migrateBookshelfToInstance } from "./platform/migrate-bookshelf-to-instance.js";
import { mergeLabelsQr } from "./platform/merge-labels-qr.js";
import { backfillPlacements } from "./platform/migrate-location-to-placement.js";
import { backfillDefaultBindings } from "./platform/seed-bindings.js";
import { repairReplayTruncatedNames } from "./platform/repair-replay-truncated-names.js";
import { backfillIdentityLinks } from "./platform/backfill-identity.js";
import { logAnnounceRouting } from "./platform/announce.js";
import { logSignupGates } from "./platform/signup-gates.js";
import { startTrialReaper } from "./platform/reap-trials.js";
import { startDbUpgradeHoldWatch } from "./platform/db-upgrade-status.js";
import { reconcileOrphanTenantRoles } from "./platform/reconcile-tenant-roles.js";
import { reconcileScanCategoryFields } from "./platform/reconcile-scan-category.js";
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
      withDb: (orgId, fn) => withTenantDbForSweep(orgId, fn),
    },
    resolvables: {
      register: registerResolvable,
      resolve: resolveValue,
    },
    db: { meta },
    entities: {
      registerResolver: entities.registerResolver,
      registerWriter: entities.registerEntityWriter,
      getWriter: (kind) => entities.getEntityWriter(kind) ?? null,
      dependents: async (kind, orgId, id) => {
        const w = entities.getEntityWriter(kind);
        return w?.dependents ? await w.dependents(orgId, id) : null;
      },
      snapshot: async (kind, orgId, id) => {
        const w = entities.getEntityWriter(kind);
        return w?.snapshot ? await w.snapshot(orgId, id) : null;
      },
      restore: async (kind, orgId, image) => {
        const w = entities.getEntityWriter(kind);
        if (!w?.restore) return false;
        await w.restore(orgId, image);
        return true;
      },
      registerListResolver: entities.registerListResolver,
      registerInstanceListResolver: entities.registerInstanceListResolver,
      registerInstanceResolver: entities.registerInstanceResolver,
      // The kernel owns trait-scope resolution (it needs matchAction), so it
      // answers "which roled fields apply here" rather than making every module
      // reimplement a matcher and get `@physical` wrong.
      roledFieldsFor: async (orgId, kind) => {
        const defs = await resolveFieldDefsForKind(orgId, kind);
        return defs
          .filter((d) => d.field_role)
          .map((d) => ({
            name: d.name,
            field_role: d.field_role,
            type: d.type,
            choices: (d.choices as string[] | null) ?? null,
          }));
      },
      registerComputedContext: computedFields.registerComputedContext,
      registerCreateDefaults: createDefaults.registerCreateDefaults,
      unregisterCreateDefaults: createDefaults.unregisterCreateDefaults,
      resolveCreateDefaults: createDefaults.resolveCreateDefaults,
      registerDeviceApply: deviceApply.registerDeviceApply,
      applyDevice: deviceApply.applyDevice,
      registerScannable: scanRegistry.registerScannable,
      getScannable: scanRegistry.getScannable,
      getScannableForModule: scanRegistry.getScannableForModule,
      listScannable: scanRegistry.listScannable,
      lookup: entities.lookup,
      lookupMany: entities.lookupMany,
      list: entities.list,
      walkPairings: entities.walkPairings,
      walkPath: entities.walkPath,
      listKinds: entities.listKinds,
      listKindsForOrg: entities.listKindsForOrg,
      getKind: entities.getKind,
      detailPathForEntity: entities.detailPathForEntity,
      titleForEntity: entities.titleForEntity,
      resolvedKindForEntity: entities.resolvedKindForEntity,
      baseKindOf: entities.baseKindOf,
      // Modules call this on rows their OWN list route queried, so a record
      // reads the same whichever URL asked for it. See field-labels.ts.
      withFieldLabels,
      serverManagedFields: entities.serverManagedFields,
    },
    actions: {
      registerHandler: actions.registerHandler,
      listApplicable: actions.listApplicable,
      invoke: actions.invoke,
    },
    live: {
      registerCapability: live.registerCapability,
      applicable: live.applicable,
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
      del: sharedCache.del,
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
    connections: {
      registerProvider: connectionsImpl.registerProvider,
      listProviders: connectionsImpl.listProviders,
      getProvider: connectionsImpl.getProvider,
      resolve: connectionsImpl.resolve,
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
      registerMover: registerMover,
      patchDerivedConfig: instancesImpl.patchInstanceDerivedConfig,
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
      // count(*) + max(created_at) grouped by target, in ONE query for the whole
      // page. Rides entity_pairings_target_idx (org_id, target_kind, target_id).
      // NOT filtered by source_kind on purpose: "how many units does this model
      // have" counts every unit paired to it, whatever kind the unit row is —
      // the relationship is what makes it a unit, not the kind.
      countByTargets: async ({ orgId, targetKind, targetIds, relationshipKind }) => {
        if (targetIds.length === 0) return [];
        const rows = await meta
          .selectFrom("entity_pairings")
          .select(({ fn }) => [
            "target_id as targetId",
            fn.count<number>("id").as("count"),
            fn.max("created_at").as("latestCreatedAt"),
          ])
          .where("org_id", "=", orgId)
          .where("target_kind", "=", targetKind)
          .where("relationship_kind", "=", relationshipKind)
          .where("target_id", "in", targetIds)
          .groupBy("target_id")
          .execute();
        return rows.map((r) => ({
          targetId: r.targetId,
          // pg returns count as a string over the wire; the contract says number.
          count: Number(r.count),
          latestCreatedAt: new Date(r.latestCreatedAt as unknown as string).toISOString(),
        }));
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
          // NOTE: \x00 (an actual control byte) as the join delimiter used to be typed
          // as a RAW NUL here, which made every grep/rg treat this whole boot file
          // as binary and silently return zero matches. Same byte at runtime, but
          // written as an escape so the file stays searchable text.
          const key = `${cursor.kind}\x00${cursor.id}`;
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
  // Register the built-in resolvable providers (identifier-field, …). Synchronous
  // and idempotent; after modules load so their kinds' identifier fields exist.
  registerBuiltinResolvables();
  // Marketplace v0.3 PoC: register sandboxed wasm modules alongside
  // the in-process modules. They get the same Express mount + the
  // same workspace-enable toggle; the difference is invisible to
  // everything except the route handler (which goes through the
  // wasm sandbox). See docs/architecture/module-isolation.md.
  await T("loadAllSandboxedModules", loadAllSandboxedModules());
  // The kernel's OWN action handlers (platform:add-field, …) — registered
  // BEFORE the registry sync that seeds their rows, so an action is never
  // listed without its handler.
  registerPlatformActionHandlers();
  // The HTTP MCP face (POST /api/v1/hooks/mcp). Registered after the module
  // loader so its tool list reflects every loaded module's kinds and actions.
  registerHostedMcp();
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
  // (The two lens heal shims — lens modules → bundles, lens bundles →
  // instances — completed on every deployment and were retired 2026-07-17;
  // restoring a pre-2026-06 backup needs a build that still carries them.)
  // Bookshelf <=0.1.x put its fields on inventory:part — the DEFAULT instance,
  // which is always stock — so books wore a quantity/warranty and could never
  // render as the lean catalog they are. 0.2.0 gives Bookshelf its own shelf;
  // this moves an existing install (fields + the books themselves) onto it, so
  // the upgrade heals instead of stranding books in Inventory. Idempotent;
  // opens no tenant pool for a workspace that's already on the new shape.
  const shelfResult = await T("migrateBookshelfToInstance", migrateBookshelfToInstance());
  if (shelfResult.orgsTouched > 0) {
    console.log(
      `[cobblr-api] bookshelf → instance migration: ${shelfResult.orgsTouched} org(s), ${shelfResult.booksMoved} book(s) moved`,
    );
  }
  // (Two more heal shims retired 2026-07-18 after their DONE WHEN read true on
  // every deployment: enable-digifab-for-machines — 0 machine-bundle orgs
  // lacking digifab on all 4 metas — and migrate-inventory-locations — 0
  // legacy tables across all 205 tenant DBs. Restoring a backup that predates
  // those cutovers needs a build that still carries the shims.)
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
  // core-labels-qr merged into labels (0.6.0): convert each workspace's
  // enablement (rename when QR was really used, drop the ambient never-used
  // rows) + rewrite renamed-event wires. Meta-only; runs BEFORE
  // syncTenantMigrations so a renamed-to-labels org gets labels' migrations
  // (incl. 0004's table rename) in this same boot.
  const lqMerge = await T("mergeLabelsQr", mergeLabelsQr());
  if (lqMerge.renamed + lqMerge.deleted + lqMerge.wiresRewritten > 0) {
    console.log(
      `[cobblr-api] labels-qr merge: ${lqMerge.renamed} org(s) renamed to labels, ${lqMerge.deleted} ambient row(s) dropped, ${lqMerge.wiresRewritten} wire(s) rewritten`,
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

  // Put back scan names a Replay truncated before 2026-08-12 (a cache miss
  // degraded to the keyword heuristic, whose candidate name then overwrote the
  // real one). The user did nothing to cause it, so the platform undoes it
  // rather than asking them to. See platform/repair-replay-truncated-names.ts.
  const nameRepair = await T("repairReplayTruncatedNames", repairReplayTruncatedNames());
  if (nameRepair.rowsRepaired > 0) {
    console.log(
      `[cobblr-api] replay-truncated scan names: ${nameRepair.rowsRepaired} restored across ${nameRepair.orgsTouched} workspace(s)`,
    );
  }

  // Sweep per-tenant Postgres roles left behind by deleted workspaces (roles are
  // cluster-global, so DROP DATABASE never removed them). One query on a healthy
  // instance; opens no tenant pools. See platform/reconcile-tenant-roles.ts.
  const roleSweep = await T("reconcileOrphanTenantRoles", reconcileOrphanTenantRoles());
  if (roleSweep.dropped > 0 || roleSweep.skippedBroken > 0) {
    console.log(
      `[cobblr-api] orphaned tenant roles: ${roleSweep.dropped} dropped, ${roleSweep.skippedBroken} left for investigation`,
    );
  }

  // Give every workspace's scan FALLBACK table a category axis. Without one, the
  // matchmaker's only way to say "this is electrical, that is plumbing" is to
  // route them to different TABLES — which is how five electrical parts ended up
  // scattered across four near-synonym tables. Idempotent; a workspace that
  // already has an axis costs one in-memory check and opens no tenant pool.
  await T("reconcileScanCategoryFields", reconcileScanCategoryFields());

  // Self-heal the bundle-resource-claims ledger for installs that predate it,
  // so a bundle uninstall can refcount correctly. Once per org, idempotent.
  const claimsOrgs = await T("backfillBundleClaims", backfillBundleClaims());
  if (claimsOrgs > 0) {
    console.log(`[cobblr-api] bundle-resource claims backfilled for ${claimsOrgs} org(s)`);
  }

  // Central identity federation (Slice 3): link any unlinked local user to its global
  // identity by email. No-op unless IDENTITY_URL is wired. Meta-only, idempotent,
  // resilient — a failed batch never blocks boot.
  const idLinks = await T("backfillIdentityLinks", backfillIdentityLinks());
  if (idLinks.linked > 0) {
    console.log(`[cobblr-api] central identity: linked ${idLinks.linked} local user(s)`);
  }

  // Where user feedback goes. A webhook in the env or one admin-set row is the
  // difference between a private report and one posted to a chat server, and that is
  // otherwise invisible until somebody notices a card appear.
  await T("logAnnounceRouting", logAnnounceRouting());
  logSignupGates();

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

  // try/trial tier: register the single-workspace entitlement cap + log the
  // withheld modules. No-op unless COBBLR_TIER=trial.
  registerTrialMode();

  // Reap expired trial/demo workspaces (drops the tenant DB past a grace window).
  // No-op unless COBBLR_TRIAL_REAP=dry|live; only ever touches trial_expires_at-stamped
  // orgs, so prod/staging/self-host are untouchable. See platform/reap-trials.ts.
  startTrialReaper();

  // Alert the operator when the database image held back a major Postgres
  // upgrade (it serves the old major instead of dying — see
  // docker/db-auto-upgrade.sh). Silent on a healthy instance.
  startDbUpgradeHoldWatch();

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
