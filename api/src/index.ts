import { registerPanelPresence } from "./platform/panel-presence.js";
import { externalMessagingRefusal, sendExternalMessage } from "./platform/external-messages.js";
import { readEnabledPlaceValues } from "./platform/placement-values.js";
import { argChoicesFor } from "./platform/action-arg-choices.js";
import { secretPresenceDb } from "./platform/secret-presence.js";
import { registerDeletedRelations } from "./platform/deleted-relations.js";
import { money, registerExchangeRates } from "./platform/money.js";
import { roundMoneyAmount } from "@cobblr/platform-contract/money";
function mergeExcluded(totals: import("@cobblr/platform-contract/money").MoneyTotal[]): Record<string, number> {
  const excluded: Record<string, number> = {};
  for (const t of totals) for (const [c, n] of Object.entries(t.excluded)) excluded[c] = (excluded[c] || 0) + n;
  return excluded;
}
import { sumPlaceWorth } from "./platform/placement-worth.js";
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

import { MEMBER_DEFAULT_CAPABILITIES, memberHoldsByDefault } from "./platform/capability-grants.js";
import { logUploadRefused, startStaleUploadSweeper, uploadMiddleware, uploadSizeFor } from "./platform/uploads.js";
import { fileURLToPath } from "node:url";
import { withFieldLabels } from "./platform/field-labels.js";
import { dirname, resolve } from "node:path";
import { createServices, registerServicesRetention, registerServicesWorker, setServiceConfirm, setServiceConnectionPort } from "./platform/services.js";
import { confirmServiceJob, registerServiceConfirm } from "./platform/service-confirm.js";
import { registerServiceSupervisor } from "./platform/service-supervisor.js";
import { openServicesTestDoors } from "./platform/services-test-doors.js";
import { testDoorsEnabled } from "./platform/test-doors.js";
import { setPlatform, canContain, canBeContained, likeEscape, platform as platformSeams, KindRefRegex, isInstallHolder, countOf } from "@cobblr/platform-contract";
import { roleHoldsEveryCapability } from "@cobblr/platform-contract/org-roles";
import { describeBlock, describeCapabilityBlock } from "./platform/approvals.js";
import { atVersion, mergeJsonb, rowVersion } from "./platform/jsonb-merge.js";
import { selfFetch, setSelfHandler } from "./platform/self-fetch.js";
import { deleteFieldDef, effectiveFieldDefsForKind, resolveFieldDefsForKind } from "./platform/field-defs.js";
import { choiceLearns } from "@cobblr/platform-contract/field-choices";
import { pairingResultMetadata } from "@cobblr/platform-contract/pairing-presentation";
import { sql, type Kysely, type Generated } from "kysely";
import { env } from "./env.js";
import { meta, metaPool, pingMeta } from "./db/meta.js";
import { applyConnectionBudget } from "./db/apply-connection-budget.js";
import { currentActor, currentVia, perRequest } from "./lib/request-context.js";
import { endOpenStreams } from "./lib/event-stream.js";
import { runMigrations } from "./db/migrate.js";
import { getTenantDb, releaseIdleTenantPool, withTenantDbForSweep } from "./db/tenant.js";
import { runExclusive } from "./platform/exclusive.js";
import { bakeTestOrgPool, poolEnabled } from "./db/test-org-pool.js";
import { signAppToken, signSession } from "./auth/jwt.js";
import { loadAllModules } from "./modules/loader.js";
import { loadAllSandboxedModules } from "./sandbox/loader.js";
import { syncTenantMigrations, reconcileDefaultModules } from "./modules/enable.js";
import { registerWarrantyReminders } from "./platform/warranty-reminders.js";
import { registerStationSweep } from "./platform/scan-stations.js";
import { comparePlacementRemove, comparePlacementWrite } from "./platform/placement-compare.js";
import { registerSendFileSourceRecovery } from "./platform/record-send-file-confirm.js";
import { registerOwnSendRecovery, recordOwnSendFiling } from "./platform/record-send.js";
import { startDeliverySweeper } from "./platform/delivery-sweeper.js";
import { startMailboxCheckRunner } from "./platform/mail-source/check.js";
import { ensureVapidKeys } from "./platform/push-keys.js";
import { registerShareLinkOps } from "./platform/share-links.js";
import { addShareSyncPass, startShareSync } from "./platform/share-sync.js";
import * as shareMirror from "./platform/share-mirror.js";
import * as shareEdits from "./platform/share-edits.js";
import { registerShareNoticeOps, sendDueShareNotices } from "./platform/share-notices.js";
import { registerShareAdditionOps } from "./platform/share-additions.js";
import { registerShareComments } from "./platform/share-comments.js";
import { observeEvents } from "./platform/events.js";
import * as shareOffers from "./platform/share-offers.js";
import type { OfferIntake } from "@cobblr/platform-contract/share-offer";

/** The scan inbox's side of a share's hand-over, registered by its module. */
let offerIntakeImpl: OfferIntake | null = null;
import { startBridgeOutageWatch } from "./platform/edge-outages.js";
import { startPhotoRetentionSweeper } from "./platform/photo-retention.js";
import { tidy, registerTidySweep } from "./platform/tidy-suggestions.js";
import { tenantSweeps, startTenantSweeps } from "./platform/tenant-sweeps.js";
import { startPoolWatch, poolCounts } from "./db/pool-stats.js";
import { poolHolders } from "./db/client-error-guard.js";
import { tenantPoolStats } from "./db/tenant.js";
import { mountModules } from "./modules/mount.js";
import { registerBuiltinResolvables } from "./platform/resolvable-providers.js";
import { registerResolvable, resolveValue } from "./platform/resolvables.js";
import * as activity from "./platform/activity.js";
import { announceRecordChange } from "./platform/record-stream.js";
import * as actions from "./platform/actions.js";
import * as live from "./platform/live.js";
import * as devices from "./platform/devices.js";
import * as entities from "./platform/entities.js";
import * as counters from "./platform/counters.js";
import * as deletedRecords from "./platform/deleted-records.js";
import * as dispositions from "./platform/dispositions.js";
import { registerIssuedUndosSweep } from "./platform/issued-undos.js";
import { registerHistoryWriter } from "./platform/history-store.js";
import { announceWrites } from "./platform/entity-saved.js";
import * as files from "./platform/files.js";
import * as hostedSeams from "./platform/hosted-seams.js";
import { countProductMetric, trackProductEvent, trackDailyProductEvent } from "./platform/product-events.js";
import { registerConfiguredAuthEmailSender } from "./platform/auth-email-config.js";
import * as events from "./platform/events.js";
import * as connectionsImpl from "./platform/connections.js";
import * as templates from "./platform/templates.js";
import * as wires from "./platform/wires.js";
import * as health from "./platform/health.js";
import * as recurrenceRegistry from "./platform/recurrence-registry.js";
import * as calendarRegistry from "./platform/calendar-registry.js";
import { registerDateFieldSource, queryDateField, unreadableDateField } from "./platform/date-field-calendar.js";
import { registerUsedAddressSource } from "./platform/addresses-used.js";
import { dayForPerson } from "./platform/person-day.js";
import { registerDefaultRequestGuard } from "./platform/default-request-guard.js";
import { registerTrialMode } from "./platform/trial.js";
import * as computedFields from "./platform/computed-fields.js";
import * as createDefaults from "./platform/create-defaults.js";
import * as deviceApply from "./platform/device-apply.js";
import * as scanRegistry from "./platform/scan-registry.js";
import * as unitsImpl from "./platform/units.js";
import * as instancesImpl from "./platform/instances.js";
import { contentsWordOf, setContentsWord } from "./platform/contents-word.js";
import { registerMover } from "./platform/move-records.js";
import * as scanResolvers from "./platform/scan-resolvers.js";
import * as categoryAxis from "./platform/category-axis.js";
import * as queue from "./platform/queue.js";
import * as sharedCache from "./platform/shared-cache.js";
import { registerDigestContributor, digestContributions } from "./platform/digest-contributions.js";
import * as notificationsImpl from "./platform/notifications.js";
import { orgMemberIds } from "./platform/memberships.js";
import { audienceFor } from "./platform/notification-audience.js";
import * as integrationsImpl from "./platform/integrations.js";
import * as aiImpl from "./platform/ai.js";
import * as edgeImpl from "./platform/edge.js";
import * as edgeBlobs from "./platform/edge-blobs.js";
import { reverifyWhenBridgesReturn } from "./platform/connection-probe.js";
import * as egressImpl from "./platform/egress.js";
import { syncManifestRegistries } from "./platform/registry-sync.js";
import { registerPlatformActionHandlers } from "./platform/platform-action-handlers.js";
import { registerLoanCalendar } from "./platform/custody.js";
import { registerCoreDashboardReads } from "./platform/dashboard-core-reads.js";
import { registerHostedMcp } from "./platform/hosted-mcp.js";
import { syncInstalledModules } from "./platform/installed-modules.js";
import { noteHealShim } from "./platform/heal-shim-log.js";
import { notePassFailure } from "./platform/pass-failures.js";
import { backfillPlacements } from "./platform/migrate-location-to-placement.js";
import { registerDanglingPlacesHeal } from "./platform/heal-dangling-places.js";
import { backfillDefaultBindings } from "./platform/seed-bindings.js";
import { healWireBooleanArgs } from "./platform/heal-wire-boolean-args.js";
import { seedProviderFromEnv } from "./platform/oidc.js";
import { reconcileContributedFields } from "./platform/reconcile-contributed-fields.js";
import { actionGateOf, gatePasses, capabilitiesHeldBy } from "./platform/action-gates.js";
import { reconcileBundleFieldAggregates } from "./platform/reconcile-bundle-field-aggregates.js";
import { reconcileIntegrationNav } from "./platform/integration-nav.js";
import { reconcileBundleApps } from "./platform/reconcile-bundle-apps.js";
import { reconcileBundleUpdates, startBundleUpdateSweeper } from "./platform/bundle-updates.js";
import { reconcileBundleFieldRoles } from "./platform/bundle-field-roles.js";
import { reconcileBundleInstanceConfig } from "./platform/bundle-instance-config.js";
import { healBundleViewFields } from "./platform/heal-bundle-view-fields.js";
import { repairReplayTruncatedNames } from "./platform/repair-replay-truncated-names.js";
import { retireReceiptFailurePlaceholders } from "./platform/retire-receipt-failure-placeholders.js";
import { backfillIdentityLinks } from "./platform/backfill-identity.js";
import { logAnnounceRouting } from "./platform/announce.js";
import { postCardlessFeedback } from "./routes/feedback-card-post.js";
import { logSignupGates } from "./platform/signup-gates.js";
import { startTrialReaper } from "./platform/reap-trials.js";
import { startDeletionReaper } from "./platform/reap-deletions.js";
import { startOrphanFilesAudit } from "./platform/heal-orphan-files.js";
import { healHalfMadeWorkspaces } from "./platform/heal-half-made-workspaces.js";
import { startSandboxReaper } from "./platform/reap-sandboxes.js";
import { startSandboxPool } from "./platform/try-sandbox-pool.js";
import { seedSandbox } from "./platform/try-sandbox-seed.js";
import { provisionOrgForUser } from "./routes/auth.js";
import { enableDefaultModulesForOrg } from "./modules/enable.js";
import { startDbUpgradeHoldWatch } from "./platform/db-upgrade-status.js";
import { reconcileOrphanTenantRoles } from "./platform/reconcile-tenant-roles.js";
import { registerShareChildren, shareChildrenFor } from "./platform/share-children.js";
import { healCopiedCollectionLooksAtBoot } from "./platform/heal-copied-collection-looks.js";
import { healStrayInstanceLookKeysAtBoot } from "./platform/heal-stray-instance-look-keys.js";
import { reconcileShareSpaces } from "./platform/reconcile-share-spaces.js";
import { voidReadOnlyShareSuggestionsAtBoot } from "./platform/heal-void-share-suggestions.js";
import { reconcileScanCategoryFields, retireScanCategoryPlaceholders } from "./platform/reconcile-scan-category.js";
import { reconcileAppScanFallback } from "./platform/reconcile-app-scan-fallback.js";
import { backfillBundleClaims } from "./platform/backfill-bundle-claims.js";
import { scheduleOrderPageLinkHeal } from "./platform/heal-order-page-links.js";
import { handOrderPageLink } from "./routes/receipt-ingest.js";
import { healListRenames } from "./platform/heal-list-renames.js";
import { backfillInstallSideEffectClaims } from "./platform/backfill-install-side-effect-claims.js";
import {
  registerDeclarativeScanResolver,
  refreshScanUrlManifests,
} from "./platform/scan-url-resolvers/register.js";
import { runOnBoot, runOnShutdown } from "./modules/lifecycle.js";
import { registerBackupCron, seedBackupSchedules } from "./platform/backup-destinations.js";
import { outboundEmailLog, outboundEmailStatus, sendFromWorkspace } from "./platform/outbound-email.js";
import { navSurface } from "./platform/nav-surface.js";
import { registerGmailProvider } from "./platform/mail-source/provider.js";
import { registerServiceConnections, serviceConnectionPort } from "./platform/service-connections.js";
import { registerMailSourceSweep } from "./platform/mail-source/sync.js";
import { completeApp, createApp } from "./server.js";
import { splitEntityKind } from "@cobblr/platform-contract/entity-kind";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Process-level safety net: log unhandled rejections instead of
// terminating. The api has many async paths (wires, scheduler ticks,
// pg-pool reconnects); a stray rejection shouldn't take down the
// whole process. Real errors still surface via the per-pool 'error'
// listeners in db/meta.ts + db/tenant.ts.
process.on("unhandledRejection", (reason) => {
  console.error("[cobblr-api] unhandled rejection:", reason);
});

/** The one identity a placement is stored and read under: the record's base
 *  kind and id, whatever spelling the caller handed in (#3663). */
async function canonicalRef(orgId: string, ref: { kind: string; id: string }): Promise<{ kind: string; id: string }> {
  const kind = await entities.baseKindOf(orgId, ref.kind).catch(() => ref.kind);
  return { kind, id: ref.id };
}

/** How a container kind knows its parent when that nesting is not a placement
 *  (a place inside a place). Registered by the kind's own module. */
const placeParents = new Map<string, (orgId: string, id: string) => Promise<{ kind: string; id: string } | null>>();
/** How a counted kind splits and rejoins (placement.registerQuantity). */
const placeQuantities = new Map<string, import("@cobblr/platform-contract").PlacementQuantity>();
/** What a record of a kind is worth (placement.registerValue). */
const placeValues = new Map<string, (orgId: string, ids: string[] | "all") => Promise<Map<string, number | null | import("@cobblr/platform-contract").DatedMoney>>>();
/** The capability each valued kind needs a viewer to hold (a part's cost). */
const placeValueScopes = new Map<string, string>();
const placeInsuranceDetails = new Map<string, (orgId: string, ids: string[]) => Promise<Map<string, { serial?: string | null; date?: string | null }>>>();

/** The kinds whose values this viewer may not see. The system sees all. */
async function withheldKinds(orgId: string, viewer: { userId: string; role?: string } | undefined): Promise<Set<string>> {
  const out = new Set<string>();
  if (!viewer || !placeValueScopes.size) return out;
  const role =
    viewer.role ??
    (await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", viewer.userId).executeTakeFirst())?.role ??
    "guest";
  for (const [kind, scope] of placeValueScopes) {
    const ok = await platformSeams()
      .auth.userHasCapability({ orgId, userId: viewer.userId, role, actionId: scope })
      .catch(() => false);
    if (!ok) out.add(kind);
  }
  return out;
}
/** How deep a built thing is followed (a part in a card in a computer). */
const BUILT_DEPTH_MAX = 6;

/** The own value of each of these records, by `kind:id`, read from each
 *  kind's registered value. A kind that keeps none is absent. */
async function valuesOf(orgId: string, refs: ReadonlyArray<{ kind: string; id: string }>, totals: import("@cobblr/platform-contract/money").MoneyTotal[] = []): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byKind = new Map<string, string[]>();
  const main = await money.currency(orgId);
  for (const r of refs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
  for (const [kind, ids] of byKind) {
    const fn = placeValues.get(kind);
    if (!fn) continue;
    const got = await fn(orgId, ids);
    const entries = [...got].flatMap(([id, v]) => v === null ? [] : [{ id, ...(typeof v === "number" ? { value: { amount: v, currency: main }, day: "" } : v) }]);
    const total = await money.total(orgId, entries, main);
    totals.push(total);
    const converted = new Map(total.conversions.map((v) => [v.original, v.amount]));
    for (const v of entries) if (converted.has(v.value)) out.set(`${kind}:${v.id}`, converted.get(v.value)!);
  }
  return out;
}

/** How far up a path is followed: deeper than any real shelf-in-room nesting,
 *  and a stop for a cycle a bad write could leave. */
const PLACE_PATH_MAX = 12;

/** Keep the reserved room grouping on the placement primitive's tenant SQL,
 *  including bins whose room is above them and cycle-safe orphan containers. */
function locationGroupValue(kind: string) {
  return sql<string>`(
    with recursive place_path as (
      select ${kind}::text as kind, data->>'id' as id, 0 as depth,
        array[${kind} || ':' || (data->>'id')]::text[] as seen
      union all
      select next.kind, next.id, path.depth + 1, path.seen || (next.kind || ':' || next.id)
      from place_path path cross join lateral (
        select p.container_kind as kind, p.container_id as id
        from core_placement_placements p where p.containee_kind = path.kind and p.containee_id = path.id
        union all
        select 'core-locations:location', l.parent_id::text
        from core_locations_locations l where path.kind = 'core-locations:location' and l.id::text = path.id
          and l.parent_id is not null and not exists (
            select 1 from core_placement_placements p where p.containee_kind = path.kind and p.containee_id = path.id
          )
      ) next
      where path.depth < 12 and not (next.kind || ':' || next.id) = any(path.seen)
    )
    select l.name from place_path path join core_locations_locations l
      on path.kind = 'core-locations:location' and l.id::text = path.id
    where path.depth > 0
    order by (l.kind = 'container'), case when l.kind = 'container' then -path.depth else path.depth end
    limit 1
  )`;
}

function stockGroupValues(kind: string, holders: string[]) {
  const installed = sql<boolean>`exists (
    select 1 from core_placement_placements p where p.containee_kind = ${kind}
      and p.containee_id = data->>'id' and p.container_kind = any(${holders}::text[])
  )`;
  const qty = sql<number>`coalesce((data->>'qty')::numeric, 0)`;
  const spare = sql<number>`case when ${installed} then 0 when ${qty} > 0 then ${qty} else coalesce((data->>'approximate_qty')::numeric, 0) end`;
  return { installed_qty: sql<number>`case when ${installed} then ${qty} else 0 end`, spare_qty: spare };
}


/** Where each thing is, innermost container first, named (platform().placement.pathsOf). */
async function placePaths(
  orgId: string,
  asked: ReadonlyArray<{ kind: string; id: string }>,
): Promise<Map<string, Array<{ kind: string; id: string; name: string }>>> {
  const out = new Map<string, Array<{ kind: string; id: string; name: string }>>();
  if (!asked.length) return out;
  const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
  const containerOf = new Map<string, { kind: string; id: string } | null>();
  const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
  // One read per level for everything still climbing, not one per thing.
  async function load(refs: Array<{ kind: string; id: string }>): Promise<void> {
    const todo = refs.filter((r) => !containerOf.has(key(r)));
    if (!todo.length) return;
    const rows = await tdb
      .selectFrom("core_placement_placements")
      .select(["containee_kind", "containee_id", "container_kind", "container_id"])
      .where((eb) => {
        const byKind = new Map<string, string[]>();
        for (const r of todo) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
        return eb.or([...byKind].map(([k, ids]) => eb.and([eb("containee_kind", "=", k), eb("containee_id", "in", ids)])));
      })
      .execute();
    for (const r of todo) containerOf.set(key(r), null);
    for (const row of rows) containerOf.set(`${row.containee_kind}:${row.containee_id}`, { kind: row.container_kind, id: row.container_id });
    for (const r of todo) {
      if (containerOf.get(key(r))) continue;
      const parentOf = placeParents.get(r.kind);
      if (parentOf) containerOf.set(key(r), await parentOf(orgId, r.id).catch(() => null));
    }
  }
  const canon = await Promise.all(asked.map((a) => canonicalRef(orgId, a)));
  const chains = canon.map((c) => ({ at: c, steps: [] as Array<{ kind: string; id: string }> }));
  for (let depth = 0; depth < PLACE_PATH_MAX; depth++) {
    const climbing = chains.filter((c) => c.at);
    if (!climbing.length) break;
    await load(climbing.map((c) => c.at!));
    for (const c of climbing) {
      const next = containerOf.get(key(c.at!)) ?? null;
      if (next && !c.steps.some((s) => key(s) === key(next))) {
        c.steps.push(next);
        c.at = next;
      } else {
        c.at = null as never;
      }
    }
  }
  const all = [...new Map(chains.flatMap((c) => c.steps).map((s) => [key(s), s])).values()];
  const names = new Map((await entities.lookupMany(orgId, all, { system: true }).catch(() => [])).map((e) => [key(e), e.title]));
  asked.forEach((a, i) => {
    out.set(key(a), chains[i]!.steps.map((s) => ({ ...s, name: names.get(key(s)) ?? "Something" })));
  });
  return out;
}

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
    metadata: unknown;
    placed_by: string | null;
    placed_at: unknown;
  };
};

// The per-tenant DB slice platform().tags touches. Owned by the core-tags
// foundational module; mirrors its 0001 migration (name is unique on lower()).
type TagsDB = {
  core_tags_tags: { id: Generated<string>; name: string; color: string | null };
  core_tags_assignments: {
    id: Generated<string>;
    tag_id: string;
    source_module: string;
    source_type: string;
    source_id: string;
  };
};

/** "<module>:<type>" → [module, type], by the contract's one split, so the
 *  tag seam and the tag module's actions read a kind the same way. An
 *  instance kind ("<instance>:item") splits the same way. */
function splitKind(kind: string): [string, string] {
  const { module, type } = splitEntityKind(kind);
  return [module, type];
}

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
  await T("applyConnectionBudget", applyConnectionBudget());
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
    deletedRecords,
    dispositions: { markGone: dispositions.markGone, bringBack: dispositions.bringBack },
    money,
    activity: { log: activity.log, logMany: activity.logMany, createdNamesMatching: activity.createdNamesMatching, registerHistoryWriter },
    events: { emit: events.emit, on: events.on },
    tenants: {
      getDb: async (orgId) => secretPresenceDb(orgId, await getTenantDb(orgId)),
      releaseIdleDb: (orgId) => releaseIdleTenantPool(orgId),
      withDb: (orgId, fn) => withTenantDbForSweep(orgId, fn),
    },
    orgs: {
      get: async (orgId) => {
        const row = await meta
          .selectFrom("orgs")
          .select(["id", "slug", "app_mode", "portal_config"])
          .where("id", "=", orgId)
          .executeTakeFirst();
        const accent = (row?.portal_config as { admin_theme?: { accent?: unknown } } | undefined)?.admin_theme?.accent;
        return row ? { id: row.id, slug: row.slug, app_mode: row.app_mode ?? null, accent: typeof accent === "string" ? accent : null } : null;
      },
    },
    resolvables: {
      register: registerResolvable,
      resolve: resolveValue,
    },
    db: { meta, mergeJsonb, rowVersion, atVersion },
    selfFetch,
    entities: {
      registerResolver: entities.registerResolver,
      registerShareChildren,
      shareChildrenFor,
      registerWriter: entities.registerEntityWriter,
      getWriter: async (orgId, kind) => {
        const w = await entities.getEntityWriterFor(orgId, kind);
        return w ? announceWrites(orgId, kind, w) : null;
      },
      mergeMetadata: async (orgId, kind, id, fields) => {
        const w = await entities.getEntityWriterFor(orgId, kind);
        if (!w?.mergeMetadata) return false;
        await w.mergeMetadata(orgId, id, fields);
        return true;
      },
      dependents: async (orgId, kind, id) => {
        const w = await entities.getEntityWriterFor(orgId, kind);
        return w?.dependents ? await w.dependents(orgId, id) : null;
      },
      snapshot: async (orgId, kind, id) => {
        const w = await entities.getEntityWriterFor(orgId, kind);
        return w?.snapshot ? await w.snapshot(orgId, id) : null;
      },
      restore: async (orgId, kind, image) => {
        const w = await entities.getEntityWriterFor(orgId, kind);
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
        // The choices as the workspace has them, and whether the list is open:
        // a parser's value off the list is written on a field that learns (it
        // is never ADDED to the list), and held back on a closed one.
        const defs = await effectiveFieldDefsForKind(orgId, kind);
        const custom = defs
          .filter((d) => d.field_role)
          .map((d) => ({
            name: d.name,
            field_role: d.field_role,
            type: d.type,
            choices: d.choices,
            learns: choiceLearns(d),
          }));
        // The kind's own columns that declare a role (a vehicle's VIN, Paid,
        // Purchased at, Bought from) come FIRST: the record's own field is
        // the answer every screen reads, so a fact lands there before any
        // custom field claiming the same role (#4523).
        const rec = await entities.kindRecordForOrg(orgId, kind);
        const native = (rec?.fields ?? [])
          .filter((f) => f.fieldRole)
          .map((f) => ({ name: f.name, field_role: f.fieldRole!, type: f.type, choices: null, native: true, money: f.money ?? null }));
        return [...native, ...custom];
      },
      sealSecretFields: async (orgId, kind, fields, id, current) => (await import("./platform/secret-fields.js")).sealSecretFields(orgId, kind, fields, id, current),
      fieldsFor: async (orgId, kind) => {
        const defs = await perRequest(`entity-field-defs:${orgId}:${kind}`, () => effectiveFieldDefsForKind(orgId, kind));
        return defs.map((d) => ({
          name: d.name,
          display_label: d.display_label,
          field_role: d.field_role,
          type: d.type,
          ref_kind: d.ref_kind,
          choices: d.choices,
          learns: choiceLearns(d),
          unit: (d as { unit?: string | null }).unit ?? null,
          template: (d as { template?: string | null }).template ?? null,
          required: (d as { required?: boolean | null }).required === true,
          private: d.private,
        }));
      },
      countersFor: counters.countersFor,
      readCounters: counters.readCounters,
      registerComputedContext: computedFields.registerComputedContext,
      registerCreateDefaults: createDefaults.registerCreateDefaults,
      unregisterCreateDefaults: createDefaults.unregisterCreateDefaults,
      resolveCreateDefaults: createDefaults.resolveCreateDefaults,
      registerDeviceApply: deviceApply.registerDeviceApply,
      applyDevice: deviceApply.applyDevice,
      registerScannable: scanRegistry.registerScannable,
      registerLabelValuesProvider: scanRegistry.registerLabelValuesProvider,
      labelValuesFor: scanRegistry.labelValuesFor,
      getScannable: scanRegistry.getScannable,
      getScannableForModule: scanRegistry.getScannableForModule,
      listScannable: scanRegistry.listScannable,
      listScannableForOrg: scanRegistry.listScannableForOrg,
      lookup: entities.lookup,
      lookupMany: entities.lookupMany,
      list: entities.list,
      listable: entities.listable,
      listAll: entities.listAll,
      hiddenFields: entities.hiddenFieldsFor,
      exportCsv: (...args) => import("./platform/entity-export.js").then((m) => m.exportEntitiesCsv(...args)),
      walkPairings: entities.walkPairings,
      walkPath: entities.walkPath,
      listKinds: entities.listKinds,
      listKindsForOrg: entities.listKindsForOrg,
      getKind: entities.getKind,
      detailPathForEntity: entities.detailPathForEntity,
      recordAddressForEntity: entities.recordAddressForEntity,
      titleForEntity: entities.titleForEntity,
      resolvedKindForEntity: entities.resolvedKindForEntity,
      baseKindOf: entities.baseKindOf,
      resolveKind: entities.resolveKind,
      // Modules call this on rows their OWN list route queried, so a record
      // reads the same whichever URL asked for it. See field-labels.ts.
      withFieldLabels,
      serverManagedFields: entities.serverManagedFields,
    },
    panels: { registerPresence: registerPanelPresence },
    actions: {
      registerHandler: actions.registerHandler,
      registerPlanner: actions.registerPlanner,
      registerWireCheck: actions.registerWireCheck,
      registerUndo: actions.registerUndo,
      registerRequester: actions.registerRequester,
      listApplicable: actions.listApplicable,
      invoke: actions.invoke,
      undoFor: actions.undoFor,
      argChoices: argChoicesFor,
    },
    live: {
      registerCapability: live.registerCapability,
      applicable: live.applicable,
    },
    devices: {
      registerMachineRecords: devices.registerMachineRecords,
      machineRecords: devices.machineRecords,
      machineRecord: devices.machineRecord,
      registerStationVerifier: devices.registerStationVerifier,
      authorizeAtStation: devices.authorizeAtStation,
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
    nav: navSurface,
    wires: { fireEvent: wires.fireEvent, effectsOf: wires.effectsOf },
    health: {
      registerProbe: health.registerProbe,
      snapshot: health.snapshot,
      noteHealShim: (shim, found, failed) => noteHealShim(shim, found, failed),
      notePassFailure,
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
      unreadableDateField,
    },
    addresses: { registerUsedSource: registerUsedAddressSource },
    queue: {
      enqueue: queue.enqueue,
      registerWorker: queue.registerWorker,
      hasPendingJob: queue.hasPendingJob,
    },
    exclusive: { run: runExclusive },
    sweeps: tenantSweeps,
    tidy,
    sharedCache: {
      get: sharedCache.get,
      put: sharedCache.put,
      del: sharedCache.del,
    },
    notifications: {
      registerDigestContributor, digestContributions,
      dispatch: notificationsImpl.dispatch,
      orgMemberIds: async (orgId: string) => [...(await orgMemberIds(orgId))],
      audienceFor,
      orgName: async (orgId: string) =>
        (
          await meta.selectFrom("orgs").select("name").where("id", "=", orgId).executeTakeFirst()
        )?.name ?? null,
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
      chainFor: aiImpl.aiChainFor,
      modelsReportedBy: aiImpl.modelsReportedBy,
      modelRedirects: aiImpl.modelRedirects,
      invoke: aiImpl.invoke,
    },
    edge: {
      registerChannel: edgeImpl.registerChannel,
      hasChannel: edgeImpl.hasChannel,
      send: edgeImpl.send,
      fetch: edgeImpl.fetchViaEdge,
      serveBlob: edgeBlobs.serveBlob,
      relayTouch: edgeImpl.relayTouch,
      relayPoll: edgeImpl.relayPoll,
      relayRespond: edgeImpl.relayRespond,
      relayAgents: edgeImpl.relayAgents,
      listBridges: edgeImpl.listBridges,
      renameBridge: edgeImpl.renameBridge,
      disconnectBridge: edgeImpl.disconnectBridge,
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
      routedTo: connectionsImpl.routedTo,
      testConnection: connectionsImpl.testConnection,
      capabilities: connectionsImpl.capabilities,
      createWorkspaceConnection: connectionsImpl.createWorkspaceConnection,
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
      registerAttacher: files.registerAttacher,
      attach: files.attach,
      registerDetacher: files.registerDetacher,
      detach: files.detach,
      registerRemover: files.registerRemover,
      removeForGood: files.removeForGood,
      registerAttachmentLister: files.registerAttachmentLister,
      registerDescriber: files.registerDescriber,
      describe: files.describe,
      listAttachments: files.listAttachments,
      registerAttachmentsOfFile: files.registerAttachmentsOfFile,
      attachmentsOfFile: files.attachmentsOfFile,
      registerFolders: files.registerFolders,
      ensureFolder: files.ensureFolder,
      fileInto: files.fileInto,
      registerDriver: files.registerDriver,
      getDriver: files.getDriver,
      registerWorkspaceEraser: files.registerWorkspaceEraser,
      eraseWorkspace: files.eraseWorkspace,
      registerWorkspaceFolderLister: files.registerWorkspaceFolderLister,
      listWorkspaceFolders: files.listWorkspaceFolders,
    },
    instances: {
      registerItemCounter: instancesImpl.registerItemCounter,
      registerMover: registerMover,
      patchDerivedConfig: instancesImpl.patchInstanceDerivedConfig,
      configOf: async (orgId: string, instanceName: string) => (await instancesImpl.instanceConfig(orgId, instanceName))?.config ?? null,
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
    // The one place that knows where a kind's grouping axis is stored: a
    // choice field with field_role "category", or the module's own taxonomy
    // when the kind declares one (#3223).
    categoryAxis: {
      for: categoryAxis.axisFor,
      commit: categoryAxis.commitAxisValue,
      keep: categoryAxis.keepAxisValue,
      withdraw: categoryAxis.withdrawAxisValue,
    },
    scan: {
      registerUrlResolver: scanResolvers.registerScanUrlResolver,
      resolveUrl: scanResolvers.resolveScanUrl,
      registerOfferIntake: (intake) => {
        offerIntakeImpl = intake;
      },
      offerIntake: () => offerIntakeImpl,
    },
    shares: {
      recordOwnSendFiling,
      decideOffer: shareOffers.decideOffer,
      offerInboxItems: shareOffers.offerInboxItems,
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
    telemetry: {
      track: trackProductEvent,
      trackDaily: trackDailyProductEvent,
      count: countProductMetric,
    },
    vault: {
      file: async (orgId, userId, doc) => {
        const { fileIntoVault } = await import("./platform/vault.js");
        const got = await fileIntoVault(orgId, userId, doc);
        return { fileId: got.file.id, folderId: got.folder.id, folderName: got.folder.name };
      },
      link: async (orgId, userId, fileId, record) => {
        const { linkVaultFile } = await import("./platform/vault.js");
        await linkVaultFile(orgId, userId, fileId, record);
      },
      remove: async (orgId, userId, fileId) => {
        const { deleteVaultFile, VaultError } = await import("./platform/vault.js");
        try { await deleteVaultFile(orgId, userId, fileId); }
        catch (error) { if (!(error instanceof VaultError && error.status === 404)) throw error; }
      },
      countFor: async (orgId, userId, record) => {
        const { vaultDocumentsFor } = await import("./platform/vault.js");
        return (await vaultDocumentsFor(orgId, userId, record.kind, record.id)).length;
      },
    },
    accounts: {
      registerLifecycleHooks: hostedSeams.registerLifecycleHooks,
      dayFor: dayForPerson,
      currentUserId: () => currentActor()?.userId ?? null,
      personForUser: async (orgId, userId) => {
        const { personForUser } = await import("./platform/people.js");
        return personForUser(orgId, userId);
      },
      userForPerson: async (orgId, personId) => {
        const { userForPerson } = await import("./platform/people.js");
        return userForPerson(orgId, personId);
      },
      displayNames: async (orgId, userIds) => {
        const ids = [...new Set(userIds)].filter((u) => /^[0-9a-f-]{36}$/i.test(u));
        if (ids.length === 0) return {};
        const rows = await meta
          .selectFrom("users as u")
          .innerJoin("org_memberships as m", "m.user_id", "u.id")
          .select(["u.id", "u.display_name", "u.email"])
          .where("m.org_id", "=", orgId)
          .where("u.id", "in", ids)
          .execute();
        return Object.fromEntries(rows.map((r) => [r.id, r.display_name || r.email]));
      },
    },
    http: {
      registerRequestGuard: hostedSeams.registerRequestGuard,
      registerWebhook: hostedSeams.registerWebhook,
      upload: uploadMiddleware,
      uploadRefused: logUploadRefused,
      uploadSizeFor,
    },
    outboundEmail: {
      status: async (orgId) => {
        const s = await outboundEmailStatus(orgId);
        return { configured: s.configured, from: s.from };
      },
      send: (orgId, message) => sendFromWorkspace(orgId, message),
      automatedRefusal: (orgId, via) => externalMessagingRefusal(orgId, via ?? "email"),
      sendAutomated: (orgId, m) =>
        sendExternalMessage({ orgId, bindingId: m.wireId, personId: m.personId, text: m.text, record: m.record ?? null, replyLink: m.replyLink === true, via: m.via === "text" ? "text" : "email" }),
      log: async (orgId, source) =>
        (await outboundEmailLog(orgId, source)).map((r) => ({
          id: r.id,
          to: r.to_address,
          subject: r.subject,
          sentBy: r.sent_by,
          status: r.status,
          messageId: r.message_id,
          error: r.error,
          at: r.created_at.toISOString(),
        })),
    },
    hostedPanels: {
      register: hostedSeams.registerHostedPanel,
      list: hostedSeams.listHostedPanels,
      get: hostedSeams.getHostedPanel,
    },
    auth: {
      userHasRole: async ({ orgId, userId, minRole }) => {
        const membership = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", userId).executeTakeFirst();
        const { roleSatisfies } = await import("@cobblr/platform-contract/org-roles");
        return roleSatisfies(membership?.role, [minRole]);
      },
      // A handler's own check, the question its route asks (#6672): the
      // person's role in the workspace, then userHasCapability below.
      userMayRun: async ({ orgId, userId, actionId }) => {
        const membership = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", userId).executeTakeFirst();
        if (!membership) return false;
        return platformSeams().auth.userHasCapability({ orgId, userId, role: membership.role, actionId });
      },
      // Capability check walks three sources in order:
      //   1. Stock role: the admin tier (by rank, so editor too) always passes.
      //   2. Direct per-user grant (workspace_capability_grants).
      //   3. Custom-role assignment that includes the capability.
      // See docs/modules/member-portal-and-permissions.md
      // §2.4 + 2026-05-25-audit.md S2.
      userHasCapability: async ({ orgId, userId, role, actionId }) => {
        if (roleHoldsEveryCapability(role)) return true;
        // The action's own declaration (#5170): the role it runs by, read by
        // every door alike (a route that does the same thing gates here too).
        if (gatePasses(actionId, role, () => false)) return true;
        // A grant counts for the action itself or for the capability it shares.
        const ids = [actionId, ...(actionGateOf(actionId).grantedAs ? [actionGateOf(actionId).grantedAs!] : [])];
        // What the stock role holds by a module's declaration (an operator runs the machines, #6672).
        const byRole = capabilitiesHeldBy(role);
        if (ids.some((id) => byRole.has(id))) return true;
        // Direct grant.
        const grant = await meta
          .selectFrom("workspace_capability_grants")
          .select("id")
          .where("org_id", "=", orgId)
          .where("user_id", "=", userId)
          .where("action_id", "in", ids)
          .executeTakeFirst();
        if (grant) return true;
        // Custom-role assignment → role's capability bundle.
        const viaRole = await meta
          .selectFrom("workspace_role_assignments as a")
          .innerJoin("workspace_role_capabilities as c", "c.role_id", "a.role_id")
          .select("c.action_id")
          .where("a.org_id", "=", orgId)
          .where("a.user_id", "=", userId)
          .where("c.action_id", "in", ids)
          .limit(1)
          .executeTakeFirst();
        if (viaRole) return true;
        // What a plain member holds without a grant (take and put back stock),
        // unless a custom role governs them.
        const byDefault = ids.find((id) => MEMBER_DEFAULT_CAPABILITIES.includes(id));
        if (!byDefault) return false;
        const custom = await meta
          .selectFrom("workspace_role_assignments")
          .select("user_id")
          .where("org_id", "=", orgId)
          .where("user_id", "=", userId)
          .limit(1)
          .executeTakeFirst();
        return memberHoldsByDefault(role, byDefault, !!custom);
      },
      describeBlockedCapability: (args) => describeCapabilityBlock(args),
      describeBlock: (args) => describeBlock(args),
      mintAppToken: ({ userId, appSlug }) => signAppToken(userId, appSlug),
      mintSession: ({ userId }) => signSession(userId),
      requestSource: async () => {
        const actor = currentActor();
        if (!actor) return null;
        const via = currentVia();
        const tok = actor.authMethod === "api_token" && actor.apiTokenId
          ? await meta.selectFrom("api_tokens").select("name").where("id", "=", actor.apiTokenId).executeTakeFirst()
          : null;
        return { auth_method: actor.authMethod, via: via?.kind ?? null, token_name: tok?.name ?? null };
      },
      // An overlay's sender: never the configured one, and it replaces a
      // configured sender only when the instance says so (hosted-seams.ts).
      registerEmailSender: (sender, opts) =>
        hostedSeams.registerAuthEmailSender(sender, { name: opts?.name, source: "overlay", allowOverride: env.COBBLR_AUTH_EMAIL_ALLOW_OVERRIDE }),
      hasEmailSender: hostedSeams.hasAuthEmailSender,
      sendEmail: hostedSeams.sendAuthEmail,
    },
    // B1 from 2026-05-25-audit.md: pairings + catalogs platform
    // surfaces so modules stop SELECTing each other's tables.
    pairings: {
      create: async ({ orgId, sourceKind, sourceId, targetKind, targetId, relationshipKind, createdBy, notes, presentation }) => {
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
            ...(notes ? { notes: notes.slice(0, 500) } : {}),
            ...(presentation ? { metadata: pairingResultMetadata(presentation) } : {}),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        return { id: row.id };
      },
      present: async ({ orgId, sourceKind, sourceId, targetKind, targetId, relationshipKind, presentation }) => {
        const safe = pairingResultMetadata(presentation);
        const result = JSON.stringify(safe);
        const rows = await meta
          .updateTable("entity_pairings")
          .set({ metadata: sql`coalesce(metadata, '{}'::jsonb) || ${result}::jsonb` as unknown as Record<string, unknown> })
          .where("org_id", "=", orgId)
          .where("source_kind", "=", sourceKind)
          .where("source_id", "=", sourceId)
          .where("target_kind", "=", targetKind)
          .where("target_id", "=", targetId)
          .where("relationship_kind", "=", relationshipKind)
          .where(sql<boolean>`metadata -> 'result' is distinct from ${JSON.stringify(safe.result)}::jsonb`)
          .returning("id")
          .execute();
        return { updated: rows.length };
      },
      remove: async ({ orgId, sourceKind, sourceId, targetKind, targetId, relationshipKind }) => {
        // Org-scoped and rel-scoped, exactly like the DELETE route the UI's
        // unlink uses: a caller can only remove links of the kind it makes.
        const gone = await meta
          .deleteFrom("entity_pairings")
          .where("org_id", "=", orgId)
          .where("source_kind", "=", sourceKind)
          .where("source_id", "=", sourceId)
          .where("target_kind", "=", targetKind)
          .where("target_id", "=", targetId)
          .where("relationship_kind", "=", relationshipKind)
          .returning("id")
          .execute();
        return { removed: gone.length };
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
        let q = meta
          .selectFrom("entity_pairings")
          .select(["source_id as sourceId", "source_kind as sourceKind", "target_id as targetId"])
          .where("org_id", "=", orgId)
          .where("target_kind", "=", targetKind)
          .where("relationship_kind", "=", relationshipKind)
          .where("target_id", "in", targetIds);
        // No source kind: every kind matched to these targets (#5434).
        if (sourceKind !== undefined) q = q.where("source_kind", "=", sourceKind);
        return q.execute();
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
    fields: {
      retire: async ({ orgId, kind, name }) => {
        const rows = await meta
          .selectFrom("module_field_defs")
          .select("id")
          .where("org_id", "=", orgId)
          .where("entity_kind", "=", kind)
          .where("name", "=", name)
          .execute();
        for (const r of rows) await deleteFieldDef(orgId, r.id);
        return rows.length;
      },
      withRole: async ({ orgId, kind, role }) =>
        (await resolveFieldDefsForKind(orgId, kind)).filter((d) => d.field_role === role).map((d) => d.name),
    },
    // Tags — the in-process seam over core-tags' tables for writers that have
    // no request bearer (the sync engine). Same semantics as POST /attachments:
    // attach by name, create the tag on first use, idempotent per (tag, entity).
    tags: {
      attach: async ({ orgId, tagName, target }) => {
        const name = tagName.trim();
        if (!name) throw new Error("tags: a tag name is required");
        const [source_module, source_type] = splitKind(target.kind);
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<TagsDB>;
        const findTag = () =>
          tdb.selectFrom("core_tags_tags").select("id").where(sql`lower(name)`, "=", name.toLowerCase()).executeTakeFirst();
        let tag = await findTag();
        let tagCreated = false;
        if (!tag) {
          // Two concurrent attaches of the same NEW tag race the unique index on
          // lower(name); the loser re-reads instead of failing the import.
          const ins = await tdb
            .insertInto("core_tags_tags")
            .values({ name, color: null })
            .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
            .returning("id")
            .executeTakeFirst();
          tagCreated = !!ins;
          tag = ins ?? (await findTag());
        }
        if (!tag) throw new Error(`tags: could not create tag "${name}"`);
        const row = await tdb
          .insertInto("core_tags_assignments")
          .values({ tag_id: tag.id, source_module, source_type, source_id: target.id })
          .onConflict((oc) => oc.columns(["tag_id", "source_module", "source_type", "source_id"]).doNothing())
          .returning("id")
          .executeTakeFirst();
        if (row) {
          await events.emit("core-tags.assignment.created", {
            orgId,
            tagId: tag.id,
            source_module,
            source_type,
            source_id: target.id,
          });
        }
        return { tagId: tag.id, created: !!row, tagCreated };
      },
      withdraw: async ({ orgId, tagName }) => {
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<TagsDB>;
        const tag = await tdb
          .selectFrom("core_tags_tags").select("id").where(sql`lower(name)`, "=", tagName.trim().toLowerCase()).executeTakeFirst();
        if (!tag) return "absent";
        const carried = await tdb.selectFrom("core_tags_assignments").select("id").where("tag_id", "=", tag.id).limit(1).executeTakeFirst();
        if (carried) return "in-use";
        await tdb.deleteFrom("core_tags_tags").where("id", "=", tag.id).execute();
        return "withdrawn";
      },
      detach: async ({ orgId, tagName, target }) => {
        const [source_module, source_type] = splitKind(target.kind);
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<TagsDB>;
        const tag = await tdb
          .selectFrom("core_tags_tags").select("id").where(sql`lower(name)`, "=", tagName.trim().toLowerCase()).executeTakeFirst();
        if (!tag) return;
        const gone = await tdb
          .deleteFrom("core_tags_assignments")
          .where("tag_id", "=", tag.id)
          .where("source_module", "=", source_module)
          .where("source_type", "=", source_type)
          .where("source_id", "=", target.id)
          .returning("id")
          .executeTakeFirst();
        if (gone) {
          await events.emit("core-tags.assignment.deleted", { orgId, tagId: tag.id, source_module, source_type, source_id: target.id });
        }
      },
      of: async ({ orgId, target }) => {
        const [source_module, source_type] = splitKind(target.kind);
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<TagsDB>;
        const rows = await tdb
          .selectFrom("core_tags_assignments as a")
          .innerJoin("core_tags_tags as t", "t.id", "a.tag_id")
          .select("t.name")
          .where("a.source_module", "=", source_module)
          .where("a.source_type", "=", source_type)
          .where("a.source_id", "=", target.id)
          .orderBy("t.name")
          .execute();
        return rows.map((r) => r.name);
      },
    },
    services: createServices(),
    placement: {
      place: async ({ orgId, containee: asked, container: askedContainer, slot, placedBy, position, via, oneToASlot, qty, preserveIdentity, expected }) => {
        if (expected && (!preserveIdentity || qty !== undefined || oneToASlot)) throw new Error("placement: a guarded move keeps the whole record distinct");
        if (position && !(Number.isFinite(position.x_mm) && Number.isFinite(position.y_mm))) {
          throw new Error("placement: a position is two numbers, x_mm and y_mm");
        }
        // A kind is <module>:<name>. A malformed one ("inventory:groceries:item")
        // was stored, and every lookup of the record then missed it: the thing
        // was placed nowhere anyone could see.
        for (const r of [asked, askedContainer]) {
          if (!KindRefRegex.test(r.kind)) throw new Error(`placement: ${r.kind} is not a kind (<module>:<name>)`);
        }
        // One record, one key: whatever spelling the caller holds (a
        // collection's "home-inventory:item" from a search, the base
        // "inventory:part" from the record page), placements are stored and
        // read under the base kind, the key the location trigger already
        // writes. Two spellings were two rows: the same fan in the Bedroom
        // and the Garage at once (#3663).
        let containee = await canonicalRef(orgId, asked);
        const container = await canonicalRef(orgId, askedContainer);
        if (containee.kind === container.kind && containee.id === container.id) {
          throw new Error("placement: an entity cannot contain itself");
        }
        const counted = placeQuantities.get(containee.kind);
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
        // The container has to exist. Nothing here checked, so a placement
        // into "(will be created)" was written and confirmed "Done" (an
        // assistant proposed the move before the bin it had asked to make,
        // 2026-09-21, #3255); the thing then had a home no list could show.
        // A kind the registry knows is looked up; an unknown kind is left to
        // the caller, as the trait gate leaves it.
        if (ctnrKind) {
          const there = await entities.lookup(orgId, container.kind, container.id).catch(() => null);
          if (!there) {
            throw new Error(`placement: there is no ${(ctnrKind.display_name || container.kind).toLowerCase()} with id ${container.id} to put this in`);
          }
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
        // Only some of it: the kind's module takes that many off into a record
        // of its own, and that record is the one placed (2 of 4 sticks).
        // The split-off part remembers where the rest is, so "back where it
        // was" takes it there and it joins them.
        let cameFrom: { kind: string; id: string; slot: string | null } | null = null;
        if (qty !== undefined && counted) {
          if (!(Number.isFinite(qty) && qty > 0)) throw new Error("placement: say how many, more than none");
          const have = await counted.quantityOf(orgId, containee.id);
          if (have != null) {
            if (qty > have) throw new Error(`placement: there ${have === 1 ? "is" : "are"} only ${have}`);
            if (qty < have) {
              const src = await tdb
                .selectFrom("core_placement_placements")
                .select(["container_kind", "container_id", "slot"])
                .where("containee_kind", "=", containee.kind)
                .where("containee_id", "=", containee.id)
                .executeTakeFirst();
              if (src) cameFrom = { kind: src.container_kind, id: src.container_id, slot: src.slot ?? null };
              containee = { kind: containee.kind, id: await counted.split({ orgId, id: containee.id, qty, userId: placedBy ?? null }) };
            }
          }
        }
        // Upsert — one container per containee (moving re-points the same row).
        // The pin: given, it is set (null clears it); not given, it is kept
        // while the thing stays in the same container and dropped when it
        // moves to another, whose floor it did not measure.
        const prev = await tdb
          .selectFrom("core_placement_placements")
          .select(["container_kind", "container_id", "slot", "metadata"])
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .executeTakeFirst();
        const md: Record<string, unknown> =
          prev?.metadata && typeof prev.metadata === "object" && !Array.isArray(prev.metadata) ? { ...(prev.metadata as Record<string, unknown>) } : {};
        const sameContainer = !!prev && prev.container_kind === container.kind && prev.container_id === container.id;
        if (position) md.position = { x_mm: position.x_mm, y_mm: position.y_mm };
        else if (position === null || !sameContainer) delete md.position;
        // Where it was before, so it can go back there: a spool loaded onto a
        // printer returns to its own shelf when another takes its slot.
        if (!prev) delete md.came_from;
        else if (!sameContainer) md.came_from = { kind: prev.container_kind, id: prev.container_id, slot: prev.slot ?? null };
        if (cameFrom) md.came_from = cameFrom;
        // A slot that holds one thing: whatever is in it now goes home first.
        const displaced: Array<{ kind: string; id: string; to: { kind: string; id: string } | null }> = [];
        if (oneToASlot && slot) {
          const occupants = await tdb
            .selectFrom("core_placement_placements")
            .select(["containee_kind", "containee_id"])
            .where("container_kind", "=", container.kind)
            .where("container_id", "=", container.id)
            .where("slot", "=", slot)
            .execute();
          for (const o of occupants) {
            if (o.containee_kind === containee.kind && o.containee_id === containee.id) continue;
            const ref = { kind: o.containee_kind, id: o.containee_id };
            const to = await platformSeams().placement.returnHome({ orgId, containee: ref, placedBy: placedBy ?? null, ...(via ? { via } : {}) });
            displaced.push({ ...ref, to });
          }
        }
        const metadata = sql`${JSON.stringify(md)}::jsonb`;
        if (expected) await comparePlacementWrite(tdb, containee, {
          ...expected, container: expected.container ? await canonicalRef(orgId, expected.container) : null,
        }, { container, slot: slot ?? null, metadata: md, userId: placedBy ?? null });
        else await tdb
          .insertInto("core_placement_placements")
          .values({
            containee_kind: containee.kind,
            containee_id: containee.id,
            container_kind: container.kind,
            container_id: container.id,
            slot: slot ?? null,
            metadata,
            placed_by: placedBy ?? null,
          })
          .onConflict((oc) =>
            oc.columns(["containee_kind", "containee_id"]).doUpdateSet({
              container_kind: container.kind,
              container_id: container.id,
              slot: slot ?? null,
              metadata,
              placed_by: placedBy ?? null,
              placed_at: sql`now()`,
            }),
          )
          .execute();
        if (via?.trim()) {
          const [module, entityType] = containee.kind.includes(":") ? containee.kind.split(":", 2) : [null, containee.kind];
          await activity
            .log({
              orgId,
              userId: placedBy ?? undefined,
              action: sameContainer ? "repositioned" : "moved",
              ref: { module: module ?? null, entityType: entityType ?? containee.kind, entityId: containee.id },
              diff: {
                to: { kind: container.kind, id: container.id },
                ...(prev && !sameContainer ? { from: { kind: prev.container_kind, id: prev.container_id } } : {}),
                ...(md.position ? { position: md.position } : {}),
              },
              via: { kind: "surface", label: via.trim().slice(0, 80) },
            })
            .catch((err: unknown) => console.warn("[placement] activity row not written:", (err as Error).message));
        }
        // ONE truth during the transition: keep the containee's legacy
        // location_id coherent with the placement, via the module's own entity
        // writer (the isolation-respecting cross-module write seam).
        //   into a location        → location_id = that location
        //   into an entity (server/machine) → location_id = null (it left the shelf;
        //     without this, lists kept showing the old shelf while the item was
        //     inside a container — two disagreeing answers)
        // Best-effort: kinds without a writer (custom kinds) skip the sync.
        try {
          const writer = await entities.getEntityWriterFor(orgId, containee.kind);
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
        // Something moved. Placement had no events at all, which meant nothing
        // could react to a thing being put somewhere - the single most ordinary
        // physical fact the platform records. Emitted AFTER the write and the
        // legacy sync, so a subscriber that reads the record back sees the new
        // home rather than the old one.
        try {
          events.emit("core-placement.placed", {
            orgId,
            containeeKind: containee.kind,
            containeeId: containee.id,
            containerKind: container.kind,
            containerId: container.id,
          });
        } catch (err) {
          // A subscriber must never be able to fail a move.
          console.warn("[placement] placed event not emitted:", (err as Error).message);
        }
        // A thing built from parts keeps its own history of them: "installed
        // RAM stick" on the computer, "took out SSD" when it leaves. Only an
        // install holder (an asset, a machine), never a shelf or a box.
        if (!sameContainer) {
          try {
            const holderOf = async (k: string) => isInstallHolder(((await Promise.resolve(entities.getKind(k)).catch(() => null))?.traits ?? null) as Record<string, unknown> | null);
            const into = await holderOf(container.kind);
            const outOf = prev ? await holderOf(prev.container_kind) : false;
            if (into || outOf) {
              const name = (await entities.lookupMany(orgId, [containee], { system: true }).catch(() => []))[0]?.title ?? null;
              const n = qty ?? (counted ? await counted.quantityOf(orgId, containee.id).catch(() => null) : null);
              const log = (on: { kind: string; id: string }, action: string) => {
                const [module, entityType] = on.kind.split(":", 2);
                return activity.log({
                  orgId,
                  userId: placedBy ?? undefined,
                  action,
                  ref: { module: module ?? null, entityType: entityType ?? on.kind, entityId: on.id },
                  diff: { part: { kind: containee.kind, id: containee.id, name }, ...(n != null ? { qty: n } : {}) },
                  ...(via?.trim() ? { via: { kind: "surface" as const, label: via.trim().slice(0, 80) } } : {}),
                });
              };
              if (into) await log(container, "part_installed");
              if (outOf && prev) await log({ kind: prev.container_kind, id: prev.container_id }, "part_removed");
            }
          } catch (err) {
            console.warn("[placement] built-from history not written:", (err as Error).message);
          }
        }
        // The same thing already in there as another record becomes one with
        // it: a second stick installed, a part taken back to its spares.
        let placed = containee;
        if (counted && !preserveIdentity) {
          try {
            placed = { kind: containee.kind, id: await counted.settle({ orgId, id: containee.id, container, userId: placedBy ?? null }) };
          } catch (err) {
            console.warn(`[placement] ${containee.kind} not settled:`, (err as Error).message);
          }
        }
        return { displaced, placed };
      },
      returnHome: async ({ orgId, containee: asked, placedBy, via }) => {
        const containee = await canonicalRef(orgId, asked);
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const row = await tdb
          .selectFrom("core_placement_placements")
          .select(["container_kind", "container_id", "metadata"])
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .executeTakeFirst();
        if (!row) return null;
        const home = (row.metadata as { came_from?: { kind?: unknown; id?: unknown; slot?: unknown } } | null)?.came_from;
        const seams = platformSeams().placement;
        if (home && typeof home.kind === "string" && typeof home.id === "string" && !(home.kind === row.container_kind && home.id === row.container_id)) {
          const to = { kind: home.kind, id: home.id };
          try {
            const done = await seams.place({ orgId, containee, container: to, slot: typeof home.slot === "string" ? home.slot : null, placedBy: placedBy ?? null, ...(via ? { via } : {}) });
            // A part that joined the rest there is now that record.
            return done?.placed ? { ...to, placed: done.placed } : to;
          } catch (err) {
            // The shelf it came from is gone: it leaves the container instead.
            console.warn(`[placement] ${containee.kind} ${containee.id} could not go home:`, (err as Error).message);
          }
        }
        await seams.remove({ orgId, containee });
        return null;
      },
      remove: async ({ orgId, containee: asked, expected }) => {
        const containee = await canonicalRef(orgId, asked);
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
        if (expected) await comparePlacementRemove(tdb, containee, {
          ...expected, container: expected.container ? await canonicalRef(orgId, expected.container) : null,
        });
        else await tdb
          .deleteFrom("core_placement_placements")
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .execute();
        if (prev?.container_kind === "core-locations:location") {
          try {
            const writer = await entities.getEntityWriterFor(orgId, containee.kind);
            if (writer) await writer.update(orgId, containee.id, { location_id: null });
          } catch (err) {
            console.warn(
              `[placement] location_id clear for ${containee.kind} skipped:`,
              (err as Error).message,
            );
          }
        }
      },
      containerOf: async ({ orgId, containee: asked }) => {
        const containee = await canonicalRef(orgId, asked);
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const row = await tdb
          .selectFrom("core_placement_placements")
          .select(["container_kind", "container_id"])
          .where("containee_kind", "=", containee.kind)
          .where("containee_id", "=", containee.id)
          .executeTakeFirst();
        return row ? { kind: row.container_kind, id: row.container_id } : null;
      },
      groupValues: async ({ orgId, kind: asked }) => {
        const kind = await entities.baseKindOf(orgId, asked);
        const holders = (await entities.listKindsForOrg(orgId)).filter((k) => isInstallHolder(k.traits as Record<string, unknown> | null)).map((k) => k.id);
        return { values: { location: locationGroupValue(kind) }, numbers: stockGroupValues(kind, holders) };
      },
      pathsOf: async ({ orgId, containees }) => placePaths(orgId, containees),
      holders: async ({ orgId, includePlaces }) => {
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const rows = await tdb
          .selectFrom("core_placement_placements")
          .select(["container_kind", "container_id", sql<string>`count(*)`.as("n")])
          .groupBy(["container_kind", "container_id"])
          .execute();
        if (includePlaces) return rows.map((r) => ({ kind: r.container_kind, id: r.container_id, holds: Number(r.n) }));
        // A kind whose records are places by nature (containment: container)
        // is its own module's to offer; only things that hold things are here.
        const placeKind = new Map<string, boolean>();
        for (const k of new Set(rows.map((r) => r.container_kind))) {
          const rec = await Promise.resolve(entities.getKind(k)).catch(() => null);
          placeKind.set(k, (rec?.traits as { containment?: unknown } | undefined)?.containment === "container");
        }
        return rows
          .filter((r) => !placeKind.get(r.container_kind))
          .map((r) => ({ kind: r.container_kind, id: r.container_id, holds: Number(r.n) }));
      },
      registerParent: (kind, parentOf) => {
        placeParents.set(kind, parentOf);
      },
      registerQuantity: (kind, quantity) => {
        placeQuantities.set(kind, quantity);
      },
      registerValue: (kind, valueOf, opts) => {
        placeValues.set(kind, (orgId, ids) => readEnabledPlaceValues(orgId, kind, ids, valueOf, entities.moduleEnabledForOrg));
        if (opts?.readScope) placeValueScopes.set(kind, opts.readScope);
        if (opts?.insuranceDetails) placeInsuranceDetails.set(kind, opts.insuranceDetails);
      },
      registerInsuranceDetails: (kind, reader) => { placeInsuranceDetails.set(kind, reader); },
      contentsWord: ({ orgId, kind }) => contentsWordOf(orgId, kind),
      setContentsWord: ({ orgId, kind, word }) => setContentsWord(orgId, kind, word),
      builtValue: async ({ orgId, container: asked, viewer }) => {
        // The word is the kind's as asked: a collection keeps its own.
        const word = (await contentsWordOf(orgId, asked.kind).catch(() => null))?.word ?? null;
        const top = await canonicalRef(orgId, asked);
        const hidden = await withheldKinds(orgId, viewer);
        let withheld = false;
        const totals: import("@cobblr/platform-contract/money").MoneyTotal[] = [];
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const seen = new Set<string>([`${top.kind}:${top.id}`]);
        async function partsOf(c: { kind: string; id: string }, depth: number): Promise<import("@cobblr/platform-contract").BuiltPart[]> {
          if (depth >= BUILT_DEPTH_MAX) return [];
          const rows = await tdb
            .selectFrom("core_placement_placements")
            .select(["containee_kind", "containee_id"])
            .where("container_kind", "=", c.kind)
            .where("container_id", "=", c.id)
            .execute();
          const refs = rows.map((r) => ({ kind: r.containee_kind, id: r.containee_id })).filter((r) => !seen.has(`${r.kind}:${r.id}`));
          for (const r of refs) seen.add(`${r.kind}:${r.id}`);
          if (!refs.length) return [];
          const [vals, found] = await Promise.all([valuesOf(orgId, refs.filter((r) => !hidden.has(r.kind)), totals), entities.lookupMany(orgId, refs, { system: true }).catch(() => [])]);
          if (refs.some((r) => hidden.has(r.kind) && placeValues.has(r.kind))) withheld = true;
          const names = new Map(found.map((e) => [`${e.kind}:${e.id}`, e.title]));
          const out: import("@cobblr/platform-contract").BuiltPart[] = [];
          for (const r of refs) {
            const key = `${r.kind}:${r.id}`;
            const inner = await partsOf(r, depth + 1);
            const built = inner.reduce((sum, p) => sum + p.value_total, 0);
            const value = vals.has(key) ? vals.get(key)! : null;
            const q = placeQuantities.get(r.kind);
            const qty = q ? await q.quantityOf(orgId, r.id).catch(() => null) : null;
            out.push({ ...r, name: names.get(key) ?? "Something", qty, value, built, value_total: (value ?? 0) + built });
          }
          return out.sort((a, b) => a.name.localeCompare(b.name));
        }
        const parts = await partsOf(top, 0);
        if (hidden.has(top.kind) && placeValues.has(top.kind)) withheld = true;
        const own = hidden.has(top.kind) ? undefined : (await valuesOf(orgId, [top], totals)).get(`${top.kind}:${top.id}`);
        const other = own === undefined ? null : own;
        const currency = await money.currency(orgId);
        const built = roundMoneyAmount(parts.reduce((sum, p) => sum + p.value_total, 0), currency);
        return { other, parts, built, total: roundMoneyAmount((other ?? 0) + built, currency), withheld, word, currency, excluded: mergeExcluded(totals), conversions: totals.flatMap((t) => t.conversions) };
      },
      worth: async ({ orgId, within, viewer, insurance }) => {
        if (insurance && !viewer) throw new Error("An insurance list needs a viewer.");
        if ((within || insurance) && viewer) {
          const role = viewer.role ?? (await meta.selectFrom("org_memberships").select("role").where("org_id", "=", orgId).where("user_id", "=", viewer.userId).executeTakeFirst())?.role ?? "guest";
          if (!await platformSeams().auth.userHasCapability({ orgId, userId: viewer.userId, role, actionId: "inventory:view-costs" })) {
            return { total: 0, records: 0, unpriced: 0, items: [], withheld: true };
          }
        }
        const hidden = await withheldKinds(orgId, viewer);
        const main = await money.currency(orgId);
        const all = new Map<string, { kind: string; id: string; value: number | null }>();
        const dated = new Map<string, import("@cobblr/platform-contract").DatedMoney>();
        for (const [kind, fn] of placeValues) {
          if (hidden.has(kind)) continue;
          const got = await fn(orgId, "all");
          for (const [id, value] of got) {
            const key = `${kind}:${id}`;
            all.set(key, { kind, id, value: typeof value === "number" ? value : null });
            if (value !== null) dated.set(key, typeof value === "number" ? { value: { amount: value, currency: main }, day: "" } : value);
          }
        }
        const db = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const placed = await db.selectFrom("core_placement_placements").select(["containee_kind", "containee_id"]).execute();
        const otherKinds = new Set(placed.map((r) => r.containee_kind).filter((kind) => !placeValues.has(kind)));
        for (const kind of otherKinds) {
          const registered = await entities.getKind(kind);
          if (!registered || registered.traits?.containment === "container" || !await entities.listable(orgId, kind)) continue;
          const active = await entities.listAll(orgId, kind, {}, viewer);
          if (!active.complete) throw new Error("Too many records to total safely. Narrow the inventory before exporting.");
          const ids = new Set(placed.filter((r) => r.containee_kind === kind).map((r) => r.containee_id));
          for (const record of active.items) if (ids.has(record.id)) all.set(`${kind}:${record.id}`, { kind, id: record.id, value: null });
        }
        const w = within ? await canonicalRef(orgId, within) : null;
        const rows = [...all.values()];
        const paths = w ? await placePaths(orgId, rows) : new Map();
        const selected = sumPlaceWorth(rows, paths, w);
        const entries = selected.items.flatMap((r) => {
          const value = dated.get(`${r.kind}:${r.id}`);
          return value ? [value] : [];
        });
        const sum = await money.total(orgId, entries, main);
        const converted = new Map(sum.conversions.map((v) => [v.original, v.amount]));
        const worth = { ...selected, total: sum.amount, unpriced: selected.items.filter((r) => !dated.has(`${r.kind}:${r.id}`)).length,
          currency: main, excluded: sum.excluded, conversions: sum.conversions,
          items: selected.items.map((r) => ({ ...r, value: converted.get(dated.get(`${r.kind}:${r.id}`)?.value!) ?? null })) };
        if (insurance) {
          for (const kind of new Set(worth.items.map((r) => r.kind))) {
            const detailsOf = placeInsuranceDetails.get(kind);
            if (!detailsOf) continue;
            const details = await detailsOf(orgId, worth.items.filter((r) => r.kind === kind).map((r) => r.id));
            worth.items = worth.items.map((r) => r.kind === kind ? { ...r, ...details.get(r.id) } : r);
          }
        }
        return { ...worth, withheld: [...hidden].some((k) => placeValues.has(k)) };
      },
      contents: async ({ orgId, container: asked }) => {
        const container = await canonicalRef(orgId, asked);
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<PlacementDB>;
        const rows = await tdb
          .selectFrom("core_placement_placements")
          .select(["containee_kind", "containee_id", "slot", "metadata"])
          .where("container_kind", "=", container.kind)
          .where("container_id", "=", container.id)
          .execute();
        return rows.map((r) => {
          const pos = (r.metadata as { position?: { x_mm?: unknown; y_mm?: unknown } } | null)?.position;
          const position =
            pos && typeof pos.x_mm === "number" && typeof pos.y_mm === "number" ? { x_mm: pos.x_mm, y_mm: pos.y_mm } : null;
          return { kind: r.containee_kind, id: r.containee_id, slot: r.slot, position };
        });
      },
    },
    catalogs: {
      findBySemanticType: async (orgId, semanticType) => {
        type CatalogsXReadDB = {
          core_catalogs_catalogs: {
            id: string;
            name: string;
            schema: Record<string, unknown>;
            source: string | null;
            created_at: Date;
          };
        };
        const tdb = (await getTenantDb(orgId)) as unknown as Kysely<CatalogsXReadDB>;
        // Two catalogs can declare one type (the Lego bundle's empty
        // Rebrickable parts, and the parts a person imported themselves): the
        // one holding entries answers, never whichever row came first (#5434).
        // A hosted catalog holds its entries on the reference service.
        const row = await tdb
          .selectFrom("core_catalogs_catalogs as c")
          .select(["c.id", "c.name", "c.schema"])
          .where(sql<boolean>`c.schema->>'semantic_type' = ${semanticType}`)
          .orderBy(sql`(c.source = 'hosted' or exists (select 1 from core_catalogs_entries e where e.catalog_id = c.id))`, "desc")
          .orderBy("c.created_at", "asc")
          .orderBy("c.id", "asc")
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
          .where("bundle_external_id", "like", `%${likeEscape(suffix)}`)
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
  // A connection that rides a person's bridge is re-tested when the bridge
  // comes back, so an outage does not leave it reading "Could not verify".
  reverifyWhenBridgesReturn();

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
  registerLoanCalendar();
  // The dashboard's own sections, read in its one request (#6563).
  registerCoreDashboardReads();
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
  // Things still naming a place deleted before a delete emptied it: a heal
  // pass on the kernel's sweep, never a walk of its own here.
  registerDanglingPlacesHeal();
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
  // A field a module contributes after a workspace enabled it reaches that
  // workspace too (reconcile-contributed-fields.ts).
  const contributed = await T("reconcileContributedFields", reconcileContributedFields());
  await T("reconcileIntegrationNav", reconcileIntegrationNav());
  if (contributed.added > 0) console.log(`[cobblr-api] contributed fields reconciled: ${contributed.added} added (${contributed.modules.join(", ")})`);
  // A shipped bundle's number fields add up the way its manifest now says
  // (reconcile-bundle-field-aggregates.ts).
  await T("reconcileBundleFieldAggregates", reconcileBundleFieldAggregates());
  const seeded = await T("backfillDefaultBindings", backfillDefaultBindings());
  console.log(`[cobblr-api] default bindings backfilled: ${seeded} added`);
  // A wire saved with a boolean argument as "true" is saved as true (#6130).
  await T("healWireBooleanArgs", healWireBooleanArgs());
  // A first boot with no UI: COBBLR_OIDC_* sets up the instance's sign-in
  // provider (platform/oidc.ts). One saved in the UI is left alone.
  await T("seedOidcProviderFromEnv", seedProviderFromEnv());
  await T("ensureVapidKeys", ensureVapidKeys());

  // Installed bundles catch up to the catalog on their own (patch/minor, with
  // the install route's own gates). Used to happen only when somebody opened
  // the dashboard. Idempotent: a current workspace costs one row in a meta
  // query and opens no tenant pool.
  const bundleUpdates = await T("reconcileBundleUpdates", reconcileBundleUpdates());
  if (bundleUpdates.applied > 0) {
    console.log(`[cobblr-api] bundle updates: ${bundleUpdates.applied} applied, ${bundleUpdates.skipped} left for the prompt`);
  }
  const appsReconciled = await T("reconcileBundleApps", reconcileBundleApps());
  if (appsReconciled.updated > 0) console.log(`[cobblr-api] bundle apps: ${appsReconciled.updated} updated`);
  // A field a bundle owns carries the role its current manifest declares, even
  // on an install whose update is waiting on the prompt (a lot the scan reads
  // is filed by role). Fills a missing role only; meta-only.
  const rolesFilled = await T("reconcileBundleFieldRoles", reconcileBundleFieldRoles());
  if (rolesFilled > 0) console.log(`[cobblr-api] bundle field roles: ${rolesFilled} filled from the catalog`);
  // A table a bundle installed carries the declarations its current manifest
  // makes (a Lego Sets table's parts_into), on an install from before them.
  // Fills a missing key only; meta-only.
  const tablesFilled = await T("reconcileBundleInstanceConfig", reconcileBundleInstanceConfig());
  if (tablesFilled > 0) console.log(`[cobblr-api] bundle tables: ${tablesFilled} filled from the catalog`);
  // A view a bundle seeded names fields its kind has, as the shipped bundle
  // now defines it, unless the person edited it (Lego 0.6.4's grouping).
  const viewsHealed = await T("healBundleViewFields", healBundleViewFields());
  if (viewsHealed.healed > 0) console.log(`[cobblr-api] bundle views: ${viewsHealed.healed} healed from the catalog`);

  // The one sweeper that flushes windowed notification channels. Every module
  // that wants a digest gets it from here rather than growing its own timer:
  // four modules each with a private digest is four "combined" messages a day,
  // which is the failure this exists to prevent. Costs nothing on a box where
  // nobody has set a window (one indexed "any pending?" read per tick).
  startDeliverySweeper();
  // "Check my mailbox" dry runs (#5462): a few pages each every 20 s, one process at a time.
  startMailboxCheckRunner();
  // Order emails filed before #5461: seal their store page links onto their
  // orders and scrub the archive (one-shot, after the api is listening).
  scheduleOrderPageLinkHeal(handOrderPageLink);
  await registerTidySweep();
  registerDeletedRelations();
  deletedRecords.registerDeletedRecordsSweep();
  registerIssuedUndosSweep();
  registerWarrantyReminders();
  registerStationSweep();
  registerExchangeRates();
  // Shares: what each side has to tell the other, retried until it arrives.
  registerShareLinkOps();
  shareOffers.registerShareOfferOps();
  // A share's mirror: what the owner shares, copied and kept in step. A change
  // anywhere in a workspace that shares something makes its shares due.
  shareMirror.registerShareMirrorOps();
  observeEvents((_event, orgId) => void shareMirror.noteWorkspaceChanged(orgId).catch(() => undefined));
  addShareSyncPass(shareMirror.mirrorDueShares);
  shareEdits.registerShareEditOps();
  observeEvents((_event, orgId) => void shareEdits.noteCopiesChanged(orgId).catch(() => undefined));
  // A module's route may log an edit without emitting an event: both sides
  // hear of it through the log as well.
  // An open page showing a record hears that it was written (#6337).
  activity.observeActivity((orgId, ref) => {
    if (ref.module) announceRecordChange(orgId, { kind: `${ref.module}:${ref.entityType}`, id: ref.entityId });
  });
  activity.observeActivity((orgId) => {
    void shareMirror.noteWorkspaceChanged(orgId).catch(() => undefined);
    void shareEdits.noteCopiesChanged(orgId).catch(() => undefined);
  });
  addShareSyncPass(shareEdits.sendDueCopyEdits);
  registerShareNoticeOps();
  registerShareAdditionOps();
  registerShareComments();
  addShareSyncPass(sendDueShareNotices);
  startShareSync();
  registerOwnSendRecovery();
  registerSendFileSourceRecovery();
  startBridgeOutageWatch();
  startPhotoRetentionSweeper();
  // Temporary upload files a crashed request left on disk.
  startStaleUploadSweeper();
  startBundleUpdateSweeper();
  // A pool whose callers are waiting says so in the log while it is
  // happening, once per stretch (#3033).
  startPoolWatch("meta-pool", () => poolCounts(metaPool), undefined, () => poolHolders(metaPool));
  startPoolWatch("tenant-pools", () => tenantPoolStats());

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
  // A receipt whose read failed used to be a placeholder inbox row; it is a
  // state on the session now. Move the rows already written so nobody cleans
  // up by hand. See platform/retire-receipt-failure-placeholders.ts.
  const placeholders = await T("retireReceiptFailurePlaceholders", retireReceiptFailurePlaceholders());
  if (placeholders.rowsRetired > 0) {
    console.log(
      `[cobblr-api] receipt-failure placeholders: ${placeholders.rowsRetired} retired into session state across ${placeholders.orgsTouched} workspace(s)`,
    );
  }

  // Sweep per-tenant Postgres roles left behind by deleted workspaces (roles are
  // cluster-global, so DROP DATABASE never removed them). One query on a healthy
  // instance; opens no tenant pools. See platform/reconcile-tenant-roles.ts.
  const roleSweep = await T("reconcileOrphanTenantRoles", reconcileOrphanTenantRoles());
  await T("reconcileShareSpaces", reconcileShareSpaces());
  await T("healCopiedCollectionLooks", healCopiedCollectionLooksAtBoot());
  await T("healStrayInstanceLookKeys", healStrayInstanceLookKeysAtBoot());
  await T("voidReadOnlyShareSuggestions", voidReadOnlyShareSuggestionsAtBoot());
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

  // A managed app's own table is its scan fallback, for app workspaces that
  // were provisioned before provisioning set it. Two cobblr_meta reads.
  const appFallback = await T("reconcileAppScanFallback", reconcileAppScanFallback());
  if (appFallback.orgsHealed > 0) console.log(`[cobblr-api] app scan-fallback reconcile: ${appFallback.orgsHealed} workspace(s) pointed at their app's table`);

  // Self-heal the bundle-resource-claims ledger for installs that predate it,
  // so a bundle uninstall can refcount correctly. Once per org, idempotent.
  const claimsOrgs = await T("backfillBundleClaims", backfillBundleClaims());
  if (claimsOrgs > 0) {
    console.log(`[cobblr-api] bundle-resource claims backfilled for ${claimsOrgs} org(s)`);
  }
  // List renames the assistant wrote under the bare list name, which nothing
  // read (#4495): folded into the row the app reads. One cobblr_meta read.
  const listRenames = await T("healListRenames", healListRenames());
  if (listRenames > 0) console.log(`[cobblr-api] list renames healed: ${listRenames}`);
  // The modules an install switched on before installs claimed them (#3918),
  // where the activity log can say so. One cobblr_meta query, no tenant pool.
  const sideEffectClaims = await T("backfillInstallSideEffectClaims", backfillInstallSideEffectClaims());
  if (sideEffectClaims > 0) console.log(`[cobblr-api] install side-effect claims backfilled: ${sideEffectClaims}`);

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
  // Items filed while Discord was off (or whose post failed) get their cards
  // now that it is on. Not awaited: a slow webhook never holds up boot.
  void postCardlessFeedback().catch((err: unknown) => console.error("[feedback] late cards:", err));
  logSignupGates();

  console.log(`[bootphase] === pre-createApp total: ${Date.now() - bootT0}ms ===`);
  const { app } = createApp();
  await T("mountModules", mountModules(app));
  // After the mount, not with the axis pass above: the values it moves live in
  // a module's own table and only that module's writer (registered by its api
  // bundle, just mounted) may move them. See retireScanCategoryPlaceholders.
  await T("retireScanCategoryPlaceholders", retireScanCategoryPlaceholders());
  completeApp(app);
  setSelfHandler(app as unknown as Parameters<typeof setSelfHandler>[0]);

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
  // Finish the workspaces an older signup left with no database (one-shot).
  void healHalfMadeWorkspaces().catch((err) => console.error("[heal] half-made workspaces:", (err as Error).message));
  startTrialReaper();
  // Workspaces their owners asked to delete, once the grace period is over.
  startDeletionReaper();
  // Counts the files deleted workspaces left behind (dry run: erases nothing).
  startOrphanFilesAudit();
  // Sandboxes live an hour, so they are swept in minutes, not the trial
  // reaper's six hours. No-op unless the box hands them out.
  startSandboxReaper();
  // Sandboxes built before anybody asks for one, so arriving is instant and the
  // book covers are already there. No-op unless TRY_SANDBOX_POOL is set.
  startSandboxPool({
    provisionOrg: async (userId, name) => {
      const r = await provisionOrgForUser(userId, name);
      return { orgId: r.orgId, slug: r.slug };
    },
    enableDefaults: (orgId, userId) => enableDefaultModulesForOrg(orgId, userId),
    seed: async (ws) => {
      const out = await seedSandbox(ws.orgId, ws.userId, env.TRY_SANDBOX_SEED, ws.slug);
      // WAIT for the covers here, unlike the on-demand path. Nobody is watching
      // a pooled sandbox, and the entire point is that it is finished before
      // anybody sees it - handing over one whose pictures are still arriving
      // would reproduce the thing the pool exists to fix.
      const landed = await (out.contents?.images ?? Promise.resolve(0));
      console.log(`[try-pool] ${ws.slug} seeded: ${out.contents?.created ?? 0} records, ${landed} covers`);
    },
  });

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
  // A connected mailbox (the Gmail door of receipts-by-email): the provider
  // appears under /me/connections only with a Google client configured; the
  // sweep is registered regardless, since a grant made under one config
  // outlives a restart without it and must at least say so.
  registerGmailProvider();
  // Connections of kind `service`: one definition for every service, each
  // named by its own manifest id (platform/service-connections.ts).
  registerServiceConnections();
  registerMailSourceSweep();

  // Platform-owned background work — the queue worker loop. Started
  // AFTER onBoot so modules have had a chance to register their
  // queue handlers via platform.queue.registerWorker().
  // The kernel reaches service connections through one port (the order, the
  // manifest, a signed hop); test deployments wrap that same port, so it is
  // made before either.
  const servicePort = serviceConnectionPort();
  setServiceConnectionPort(servicePort);
  registerServicesWorker();
  // The confirm (services.md section 9): a yes is bound to what was shown.
  // The gate needs no wiring; the kernel calls it directly.
  setServiceConfirm(confirmServiceJob);
  registerServiceConfirm();
  registerServicesRetention();
  // Something watching the chain, not only the job (services.md S9).
  registerServiceSupervisor();
  if (testDoorsEnabled(env.COBBLR_ENV || env.NODE_ENV, process.env.COBBLR_TEST_DOORS)) openServicesTestDoors(servicePort);
  queue.startWorker();

  void seedBackupSchedules().catch((err) =>
    console.error("[backup-cron] seed schedules failed:", (err as Error).message),
  );

  console.log(`[bootphase] === boot total (to listen): ${Date.now() - bootT0}ms ===`);
  const server = app.listen(env.API_PORT, () => {
    console.log(`[cobblr-api] listening on :${env.API_PORT} (${env.NODE_ENV})`);
  });
  // The cross-tenant passes, once the api is serving: one walk per round with
  // one budget, each pass's first round spread over its cadence (#3036).
  // COBBLR_SWEEP_START_AFTER_MS keeps the first round clear of boot.
  startTenantSweeps({ startAfterMs: Number(process.env.COBBLR_SWEEP_START_AFTER_MS) || 60_000 });

  // TEST-ONLY: fill the pre-provisioned org pool AFTER listen (so /healthz is
  // fast) and in the background — CI polls /test-support/pool-status before
  // starting the suite. No-op unless COBBLR_TEST_ORG_POOL is set (prod never
  // sets it). The offline image/tarball bake makes this a fast no-op (pool
  // already full); the boot bake is the in-job / PoC path.
  if (poolEnabled() && env.COBBLR_TEST_ORG_POOL_SIZE) {
    const target = env.COBBLR_TEST_ORG_POOL_SIZE;
    void bakeTestOrgPool(target)
      .then((r) => console.log(`[test-org-pool] boot bake done: ${countOf(r.total, "org")} ready`))
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
    const streams = endOpenStreams();
    if (streams) console.log(`[cobblr-api] ended ${streams} open stream(s); their tabs reconnect`);
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
