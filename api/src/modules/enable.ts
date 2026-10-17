// Module enablement. Turns "module X is installed for org Y" into
// real state: tenant DB has X's tables, cobblr_meta.org_modules has
// the row.
//
// Idempotent — calling twice for the same (org, module) is a no-op.
// Failing partway through (migrations applied but row not inserted,
// or vice versa) leaves the system recoverable: a later re-run picks
// up where it left off because each migration tracks itself in the
// tenant DB's own `migrations` table.

import { resolve } from "node:path";
import { readdirSync } from "node:fs";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { runMigrations } from "../db/migrate.js";
import { migrateConcurrently } from "./migrate-concurrently.js";
import { describeMigrationFiles, healthVerdict, unreadableMigrationFiles, moduleIsBehind, newerName, pendingCause, type ModuleMigrationFiles, type PendingCause } from "./migration-currency.js";
import { getTenantPool, evictTenantPool } from "../db/tenant.js";
import { canonicalModuleName, getEntry, listEntries } from "./registry.js";
import * as activity from "../platform/activity.js";
import { isTrialDenied, isTrialDeniedForOrg } from "../platform/trial.js";
import { clearEnabledModulesCache } from "../platform/entities.js";
import { moduleHasScanFallback, reconcileScanCategoryFor } from "../platform/reconcile-scan-category.js";
import { runSweepEnableSteps } from "../platform/tenant-sweeps.js";
import { recordClaim } from "../platform/bundle-claims.js";
import { releaseEmptyDefaultInstance } from "../platform/instances.js";
import { applyContributedFieldDefs } from "../platform/contributed-fields.js";
import { hideIntegrationNavForOrg } from "../platform/integration-nav.js";

/** Maintainer-curated foundational set. A module manifest can declare
 *  `band: "foundational"`, but the kernel only TREATS it as foundational
 *  (always-on + undisableable) if it's on this list. A `foundational` flag
 *  on any other module is a stray — we warn and treat it as `stock`
 *  (disableable), so no module can silently make itself permanent.
 *  (Audit 2026-06-26 P1 #2 — manifest-contract.md says the flag should be
 *  informational unless curated.) */
const FOUNDATIONAL_ALLOWLIST = new Set([
  "core-files",
  "core-notifications",
  "core-activity-log",
  "core-tags",
  "core-queue",
  "core-healthcheck",
  "core-locations",
  "core-placement",
  "core-services",
]);

const warnedNonCuratedFoundational = new Set<string>();
/** A module a workspace is born with, no decision asked: foundational or
 *  autoEnable. Everything else is a person's choice (and carries their
 *  claim when they make it). */
export function isDefaultModule(entry: { manifest: { name: string; band: string; autoEnable?: boolean; retirement?: unknown } }): boolean {
  if (entry.manifest.retirement) return false;
  return isFoundational(entry) || entry.manifest.autoEnable === true;
}

function isFoundational(entry: { manifest: { name: string; band: string } }): boolean {
  if (entry.manifest.band !== "foundational") return false;
  if (FOUNDATIONAL_ALLOWLIST.has(entry.manifest.name)) return true;
  if (!warnedNonCuratedFoundational.has(entry.manifest.name)) {
    warnedNonCuratedFoundational.add(entry.manifest.name);
    console.warn(
      `[modules] ${entry.manifest.name} declares band:"foundational" but is not in the curated foundational allowlist — treating it as a disableable stock module.`,
    );
  }
  return false;
}
import { getSandboxedModuleInfo } from "../sandbox/sandboxed-module-info.js";
import { bumpWorkspaceShape } from "../platform/workspace-shape.js";
import { ensureModuleRole, moduleRolesEnabled } from "../sandbox/module-role.js";
import { notePassFailure } from "../platform/pass-failures.js";

/** Provision the per-module Postgres role for a sandboxed module (no-op
 *  for in-process modules / when superuser DB access is unavailable).
 *  Best-effort + never throws — failure just leaves the module on the
 *  lexer-only path. See sandbox/module-role.ts. */
async function ensureSandboxRole(orgId: string, moduleName: string): Promise<void> {
  const info = getSandboxedModuleInfo(moduleName);
  if (!info) return; // not a sandboxed module
  try {
    await ensureModuleRole({
      orgId,
      moduleName,
      prefix: info.prefix,
      readsTables: info.readsTables,
    });
  } catch (err) {
    notePassFailure("enable.sandbox-role", `${orgId}:${moduleName}`, err);
    console.error(`[enable] sandbox role setup failed for ${moduleName}:`, (err as Error).message);
  }
}

/** Re-ensure EVERY sandboxed module's role in an org. Called after any
 *  enable / after a tenant's migration sweep, so a module's cross-module
 *  `reads` grant lands even when its read-target module is enabled
 *  AFTER it (the grant needs the target table to already exist). No-op
 *  unless SANDBOX_MODULE_ROLES is enabled. */
async function ensureAllSandboxRolesForOrg(orgId: string): Promise<void> {
  if (!moduleRolesEnabled()) return; // fully inert when the layer is off
  const rows = await meta
    .selectFrom("org_modules")
    .select("module_name")
    .where("org_id", "=", orgId)
    .execute();
  for (const r of rows) await ensureSandboxRole(orgId, r.module_name);
}

export class ModuleRetiredError extends Error {}

export interface EnableResult {
  alreadyEnabled: boolean;
  migrationsApplied: number;
  lastMigration: string | null;
}

async function ensurePlacementSyncIfLocated(orgId: string, moduleName: string): Promise<void> {
  // Transitional (placement/containment): a location-bearing module gets its
  // location_id→placement sync triggers at ENABLE time, not the next boot —
  // and also on the alreadyEnabled path, because pooled/pre-provisioned orgs
  // (CI, templates) only ever hit that path. Idempotent + cheap. Dynamic
  // import avoids the enable.ts ⇄ migrate file cycle. Best-effort.
  if (
    moduleName !== "inventory" &&
    moduleName !== "machines" &&
    moduleName !== "assets" &&
    moduleName !== "records"
  )
    return;
  try {
    const { ensurePlacementSyncForOrg } = await import(
      "../platform/migrate-location-to-placement.js"
    );
    await ensurePlacementSyncForOrg(orgId);
  } catch (err) {
    notePassFailure("enable.placement-sync", `${orgId}:${moduleName}`, err);
    console.warn(`[enable] placement sync install for ${moduleName} skipped:`, err);
  }
}

/** `claimedBy` pins the module with a resource claim in that source's name
 *  (USER_SOURCE for a person turning it on by hand, on the screen, by asking
 *  the assistant, or in CI's pool bake), so a later bundle uninstall never
 *  auto-disables it. Recorded on the already-enabled path too: asking for a
 *  module you have still says you want it. A bundle install claims for its
 *  own external id through recordClaims and leaves this unset. */
export async function enableModuleForOrg(
  orgId: string,
  moduleName: string,
  options: { userId?: string; claimedBy?: string } = {},
): Promise<EnableResult> {
  moduleName = canonicalModuleName(moduleName);
  const entry = getEntry(moduleName);
  if (!entry) {
    throw new Error(`Module not registered: ${moduleName}`);
  }

  const existing = await meta
    .selectFrom("org_modules")
    .select(["version", "last_migration"])
    .where("org_id", "=", orgId)
    .where("module_name", "=", moduleName)
    .executeTakeFirst();
  if (entry.manifest.retirement && !existing) {
    throw new ModuleRetiredError(`Module ${entry.manifest.displayName} is retired. ${entry.manifest.retirement.reason}`);
  }

  // On the trial tier, withheld modules can't be enabled at all — this guards
  // the manual enable route (the default-enable path filters them out earlier,
  // so it never reaches here for a denied module). A per-demo unlock for THIS
  // workspace overrides the denial (Slice 4). No-op off-trial.
  if (await isTrialDeniedForOrg(moduleName, orgId)) {
    throw new Error(`Module ${moduleName} is not available on the trial tier.`);
  }

  // Pillar E — every declared dep must be enabled for this org
  // before we let this one on. Avoid surprising users by NOT
  // auto-cascading the enable (transparency over magic).
  for (const dep of entry.manifest.dependencies) {
    const depRow = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", orgId)
      .where("module_name", "=", canonicalModuleName(dep))
      .executeTakeFirst();
    if (!depRow) {
      throw new Error(
        `Module ${moduleName} requires ${dep} — enable ${dep} first.`,
      );
    }
  }

  if (entry.manifest.integration) await hideIntegrationNavForOrg(orgId, moduleName);

  if (existing) {
    await ensurePlacementSyncIfLocated(orgId, moduleName);
    if (options.claimedBy && !isDefaultModule(entry)) await recordClaim(orgId, options.claimedBy, "module", moduleName);
    return {
      alreadyEnabled: true,
      migrationsApplied: 0,
      lastMigration: existing.last_migration,
    };
  }

  // Pillar-E specialisation modules can omit `schema` entirely
  // when they don't own any tables. Skip the migration runner in
  // that case — the module is purely a contributions container.
  let lastMigration: string | null = null;
  let migrationsApplied: string[] = [];
  let migrationCount: number | null = 0;
  let newestBreaking: string | null = null;
  if (entry.manifest.schema) {
    const migrationsDir = resolve(entry.rootPath, entry.manifest.schema.migrationsDir);
    const pool = await getTenantPool(orgId);
    const result = await runMigrations({
      pool,
      directory: migrationsDir,
      scope: moduleMigrationScope(orgId, moduleName),
    });
    migrationsApplied = result.applied;
    lastMigration = result.latest;
    migrationCount = result.total;
    newestBreaking = result.breaking.reduce<string | null>((a, b) => newerName(a, b), null);
  }

  // Two enables of one module at once (a double press, a retried request)
  // both pass the `existing` check above; the second used to fail its insert
  // on the primary key with a 500 although the module was on (#4922). The one
  // that lands second finds it enabled, which is what it asked for.
  const inserted = await meta
    .insertInto("org_modules")
    .values({
      org_id: orgId,
      module_name: moduleName,
      version: entry.manifest.version,
      last_migration: lastMigration,
      migration_count: migrationCount,
      newest_breaking_migration: newestBreaking,
    })
    .onConflict((oc) => oc.columns(["org_id", "module_name"]).doNothing())
    .returning("module_name")
    .executeTakeFirst();
  clearEnabledModulesCache(orgId);
  if (!inserted) return { alreadyEnabled: true, migrationsApplied: migrationsApplied.length, lastMigration };

  // Provision/refresh the DB-level isolation role(s). Re-ensures ALL of
  // the org's sandboxed modules so cross-module `reads` grants land
  // regardless of enable order. No-op for in-process modules + when
  // SANDBOX_MODULE_ROLES is off. (Audit follow-up #1.)
  await ensureAllSandboxRolesForOrg(orgId);

  // Create the default instance row for this (org, module). The
  // default's instance_name matches the module's name so existing
  // module-prefix URLs and entity-kind IDs stay valid. Idempotent —
  // workspace_module_instances has a unique constraint on
  // (org_id, module_name, instance_name).
  await meta
    .insertInto("workspace_module_instances")
    .values({
      org_id: orgId,
      module_name: moduleName,
      instance_name: moduleName,
      display_name: entry.manifest.displayName ?? moduleName,
      is_default: true,
    })
    .onConflict((c) => c.columns(["org_id", "module_name", "instance_name"]).doNothing())
    .execute();
  // The menu and the filing destinations just moved (workspace-shape.ts).
  await bumpWorkspaceShape(orgId);

  // Pillar E — apply contributed field-defs + wires. Tagged with
  // source_module so disable can clean them up. Idempotent via
  // existence checks; safe to re-run.
  const contributes = entry.manifest.contributes;
  await applyContributedFieldDefs(moduleName, contributes.fieldDefs, [orgId]);
  for (const w of contributes.wires) {
    // No idempotency key on bindings; skip if a binding from this
    // module already exists for the (source_kind, action_id,
    // trigger_event) triple.
    const dup = await meta
      .selectFrom("entity_action_bindings")
      .select("id")
      .where("org_id", "=", orgId)
      .where("source_module", "=", moduleName)
      .where("source_kind", "=", w.source_kind)
      .where("action_id", "=", w.action_id)
      .where("trigger_event", w.trigger_event ? "=" : "is", w.trigger_event ?? null)
      .executeTakeFirst();
    if (dup) continue;
    await meta
      .insertInto("entity_action_bindings")
      .values({
        org_id: orgId,
        source_kind: w.source_kind,
        action_id: w.action_id,
        trigger_type: w.trigger_type,
        trigger_event: w.trigger_event ?? null,
        template: w.template ?? null,
        args: w.args ?? null,
        source_module: moduleName,
      })
      .execute();
  }

  try {
    await activity.log({
      orgId,
      userId: options.userId ?? null,
      action: "module_enabled",
      ref: { module: null, entityType: "org_module", entityId: moduleName },
      diff: {
        version: entry.manifest.version,
        migrations: migrationsApplied,
        contributed_field_defs: contributes.fieldDefs.length,
        contributed_wires: contributes.wires.length,
      },
    });
  } catch (err) {
    notePassFailure("enable.activity-log", `${orgId}:${moduleName}`, err);
    console.error(`[enable] activity logging failed for ${moduleName}:`, err);
  }

  await ensurePlacementSyncIfLocated(orgId, moduleName);

  // The module's default instance is now a table a scan can land in, so it
  // gets the scan category axis here, the moment the workspace gains it,
  // rather than at the api's next restart (#3252).
  if (moduleHasScanFallback(moduleName)) await reconcileScanCategoryFor(orgId);

  // What the module's sweeps set up on their first round (a backfill's
  // "done" marker, say), given now, so a workspace enabled between two rounds
  // is not a workspace missing it (#4091).
  await runSweepEnableSteps(orgId, moduleName);

  if (options.claimedBy && !isDefaultModule(entry)) await recordClaim(orgId, options.claimedBy, "module", moduleName);

  void sql; // re-export kept in case future cleanup needs it
  return { alreadyEnabled: false, migrationsApplied: migrationsApplied.length, lastMigration };
}

/** Disable a module for an org. Removes the org_modules row + any
 *  field-defs/wires the module contributed via Pillar E.
 *  The tenant tables (the module's own data) are NOT dropped — that
 *  would be data loss. Re-enable later and the data is still there.
 *  Cascading disable: refuses if another enabled module depends on this
 *  one.
 */
export async function disableModuleForOrg(orgId: string, moduleName: string): Promise<void> {
  // Foundational modules can't be disabled — the platform assumes
  // they're always there. The web UI hides the toggle, but enforce
  // server-side so API/CLI callers can't bypass it either.
  moduleName = canonicalModuleName(moduleName);
  const entry = getEntry(moduleName);
  if (entry && isFoundational(entry)) {
    throw new Error(
      `Cannot disable ${moduleName}: it's a foundational module and required by the platform.`,
    );
  }
  // Refuse if a dependent module is still enabled.
  const allEntries = listEntries();
  const dependents = allEntries
    .filter((e) => e.manifest.dependencies.some((dep) => canonicalModuleName(dep) === moduleName))
    .map((e) => e.manifest.name);
  if (dependents.length > 0) {
    const stillOn = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", orgId)
      .where("module_name", "in", dependents)
      .execute();
    if (stillOn.length > 0) {
      throw new Error(
        `Cannot disable ${moduleName}: still required by ${stillOn.map((s) => s.module_name).join(", ")}.`,
      );
    }
  }
  await meta
    .deleteFrom("module_field_defs")
    .where("org_id", "=", orgId)
    .where("source_module", "=", moduleName)
    .execute();
  await meta
    .deleteFrom("entity_action_bindings")
    .where("org_id", "=", orgId)
    .where("source_module", "=", moduleName)
    .execute();
  await meta
    .deleteFrom("org_modules")
    .where("org_id", "=", orgId)
    .where("module_name", "=", moduleName)
    .execute();
  // On then off leaves the workspace as it was: the empty default collection
  // enable made goes too (a re-enable makes it again).
  await releaseEmptyDefaultInstance(orgId, moduleName);
  clearEnabledModulesCache(orgId);
  await bumpWorkspaceShape(orgId);
  try {
    await activity.log({
      orgId,
      action: "module_disabled",
      ref: { module: null, entityType: "org_module", entityId: moduleName },
    });
  } catch (err) {
    console.error(`[disable] activity logging failed for ${moduleName}:`, err);
  }
}

/** Scan every (org, module) in org_modules and run any pending
 *  migrations against the tenant DB. The migration runner is
 *  idempotent (tracks applied names in the tenant's own `migrations`
 *  table), so this is safe to call on every boot — it just no-ops
 *  for tenants that are already current.
 *
 *  Solves the "module added a new migration after the org enabled
 *  the module" gap: previously the new migration would never run
 *  because enableModuleForOrg short-circuits when org_modules
 *  already has a row. Now boot reconciles them.
 *
 *  Returns the total number of (org, module) pairs that had at
 *  least one migration applied. */
/** The (workspace, module) rows a migration can be applied to: workspaces
 *  with tenant credentials only. A workspace whose signup never finished
 *  provisioning keeps the module rows it was given, and has no database: the
 *  sync could only fail on it ("has not been provisioned yet") at every boot,
 *  and the health count read that as a migration this api never applied, a
 *  deploy refusal over one half-made workspace (#3982). The sync and the
 *  count read the rows here, so they cannot disagree about which workspaces
 *  exist; reconcileDefaultModules skips the same workspaces. Finishing or
 *  removing a half-made signup belongs to provisioning. */
export async function provisionedModuleRows(): Promise<
  Array<{ org_id: string; module_name: string; last_migration: string | null; migration_count: number | null; newest_breaking_migration: string | null }>
> {
  return meta
    .selectFrom("org_modules")
    .innerJoin("orgs", "orgs.id", "org_modules.org_id")
    .where("orgs.db_credentials_encrypted", "is not", null)
    .select([
      "org_modules.org_id",
      "org_modules.module_name",
      "org_modules.last_migration",
      "org_modules.migration_count",
      "org_modules.newest_breaking_migration",
    ])
    .execute();
}

/** Workspaces that hold module rows but were never provisioned. */
async function unprovisionedWorkspaceCount(): Promise<number> {
  const r = await meta
    .selectFrom("org_modules")
    .innerJoin("orgs", "orgs.id", "org_modules.org_id")
    .where("orgs.db_credentials_encrypted", "is", null)
    .select(sql<string>`count(distinct org_modules.org_id)`.as("n"))
    .executeTakeFirst();
  return Number(r?.n ?? 0);
}

/** What a module's declared migrations directory holds on this build. A
 *  module with no schema has nothing to apply; a declared directory that
 *  cannot be read is NOT that (#7154): an empty answer let boot skip every
 *  workspace and health report current for an api whose queries need
 *  columns the tenants never got. Boot and health both read through here. */
export function moduleMigrationFiles(moduleName: string): ModuleMigrationFiles {
  const entry = getEntry(moduleName);
  if (!entry?.manifest.schema) return describeMigrationFiles([]);
  const dir = resolve(entry.rootPath, entry.manifest.schema.migrationsDir);
  try {
    return describeMigrationFiles(readdirSync(dir));
  } catch (err) {
    const reason = `${moduleName}: cannot read its migrations at ${dir}: ${(err as Error).message}`;
    console.error(`[migrate] ${reason}`);
    return unreadableMigrationFiles(reason);
  }
}

export async function syncTenantMigrations(): Promise<number> {
  // The version marker first, meta-side and per MODULE, not per workspace: a
  // manifest bump with no new migration left every existing workspace's
  // org_modules.version at whatever it was when the module was enabled, so
  // the modules list said 0.40.0 on a workspace running 0.40.1 and a pooled
  // org disagreed with a fresh signup on the same module (the parity test's
  // catch, #3268). One UPDATE per module that moved; no tenant DB is opened.
  // BORN WITH: enableModuleForOrg (writes the manifest version at enable).
  for (const entry of listEntries()) {
    try {
      // SHAPE-UNCHANGED: the version marker of a module already on; nothing a person sees moves.
      await meta
        .updateTable("org_modules")
        .set({ version: entry.manifest.version })
        .where("module_name", "=", entry.manifest.name)
        .where("version", "<>", entry.manifest.version)
        .execute();
    } catch (err) {
      console.error(`[migrate-sync] version marker for ${entry.manifest.name}:`, (err as Error).message);
    }
  }

  const rows = await provisionedModuleRows();
  let touched = 0;

  // PRE-CHECK (meta-side, no tenant open): what is on disk per module, computed
  // once + cached, against the row's marker (last name AND ledger count; the
  // decision is moduleIsBehind, and its file says why a name alone was not
  // enough). An (org, module) that is current is skipped without OPENING that
  // tenant DB. This turns the pooled-boot common case (nothing pending across
  // ~250 orgs) from ~10s of open→check→evict into a few compares.
  const filesByModule = new Map<string, ModuleMigrationFiles>();
  const filesFor = (moduleName: string): ModuleMigrationFiles => {
    const cached = filesByModule.get(moduleName);
    if (cached !== undefined) return cached;
    const files = moduleMigrationFiles(moduleName);
    filesByModule.set(moduleName, files);
    return files;
  };

  // Group by org, keeping a module only if it might be BEHIND (has migrations AND
  // the org's pointer != the newest file) — OR when SANDBOX_MODULE_ROLES is on, in
  // which case every org still needs ensureAllSandboxRolesForOrg, so nothing is
  // skipped there. Orgs whose every module is current (and roles off) are dropped
  // before any tenant pool is opened. The kept orgs then run through a BOUNDED
  // worker pool: peak = CAP live tenant pools (CAP × max:5 conns). At CAP=10 that's
  // 50 connections — under Postgres `max_connections` (CI 400; prod default 100)
  // and clear of the SUPERUSER-reserved ceiling. DDL contention isn't a concern:
  // the rare real-migration case runs DDL on SEPARATE tenant DBs (no shared
  // catalog). Each org evicts its pool the moment it's done, so the peak stays
  // bounded by CAP, never by org count.
  const rolesOn = moduleRolesEnabled();
  const byOrg = new Map<string, string[]>();
  for (const row of rows) {
    const behind = moduleIsBehind(row, filesFor(row.module_name));
    if (behind || rolesOn) {
      const list = byOrg.get(row.org_id);
      if (list) list.push(row.module_name);
      else byOrg.set(row.org_id, [row.module_name]);
    }
  }
  const processOrg = async (orgId: string, moduleNames: string[]): Promise<void> => {
    try {
      for (const moduleName of moduleNames) {
        const entry = getEntry(moduleName);
        if (!entry || !entry.manifest.schema) continue;
        try {
          const migrationsDir = resolve(
            entry.rootPath,
            entry.manifest.schema.migrationsDir,
          );
          const pool = await getTenantPool(orgId);
          const result = await runMigrations({
            pool,
            directory: migrationsDir,
            scope: `tenant ${orgId} / module ${moduleName}`,
          });
          if (result.applied.length > 0) touched++; // single-threaded event loop — ++ between awaits is safe
          // Update the meta-side marker so /modules/:slug/health and the next
          // boot's pre-check stay accurate. Written even when nothing was
          // applied: a workspace opened because its count was NULL must not be
          // opened again next boot for the same reason.
          // SHAPE-UNCHANGED: migration bookkeeping on a module already on.
          await meta
            .updateTable("org_modules")
            .set({
              last_migration: result.latest,
              migration_count: result.total,
              // greatest() skips a NULL, so an api that applied nothing
              // breaking never erases what a newer one recorded.
              ...(result.breaking.length
                ? { newest_breaking_migration: sql<string>`greatest(newest_breaking_migration, ${result.breaking.reduce<string | null>((a, b) => newerName(a, b), null)})` }
                : {}),
            })
            .where("org_id", "=", orgId)
            .where("module_name", "=", moduleName)
            .execute();
        } catch (err) {
          console.error(
            `[migrate-sync] failed for ${moduleName} on ${orgId}:`,
            (err as Error).message,
          );
        }
      }
      // After ALL of this org's modules have migrated (so every read-target
      // table exists), retrofit the per-module Postgres roles. Idempotent +
      // self-healing for installs that predate the role layer; no-op unless
      // SANDBOX_MODULE_ROLES is on. (Audit follow-up #1.)
      await ensureAllSandboxRolesForOrg(orgId);
    } finally {
      // Safe pre-`listen`: nothing is serving traffic, and the pool lazily
      // reopens on this org's first real request.
      await evictTenantPool(orgId);
    }
  };
  const entries = [...byOrg.entries()];
  const CAP = 10;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < entries.length) {
      const [orgId, moduleNames] = entries[cursor++]!;
      await processOrg(orgId, moduleNames);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CAP, entries.length) }, worker));
  return touched;
}

/** What /healthz reports about migrations: how many (workspace, module) pairs
 *  the boot-time sync would still open, and which modules. Zero after a good
 *  boot, since syncTenantMigrations runs before listen. Non-zero means a
 *  per-workspace failure was logged and swallowed, or a workspace was enabled
 *  behind this build's back: either way this container is serving a module
 *  whose tables may not match its queries, and the roll in front of it
 *  should refuse to swap it in (#2944). Meta-side only, cached briefly:
 *  healthz is polled by every open tab and by the deploy tooling.
 *
 *  AHEAD is reported beside it, never inside it: a peer declared to share
 *  this database (COBBLR_SHARED_DB_PEER, the canary channel) is a newer build
 *  whose migrations reach this api's ledgers. When none of them breaks an
 *  older reader that this build never shipped, the pair is information
 *  ("the peer is ahead by N"), not a refusal; see healthVerdict. */
export interface MigrationSummary {
  /** `unprovisioned_workspaces`: workspaces with module rows and no tenant
   *  database this api can open. Never pending (there is nothing to migrate
   *  into) and never a refusal, but said, so a half-made signup stays in
   *  sight instead of vanishing from every count.
   *  `causes`: how many pending pairs are each kind (pendingCause), and
   *  `breaking`: a declared peer's breaking migrations as module/file, so the
   *  deploy reader names the cause it has instead of listing three. */
  pending: { count: number; modules: string[]; unprovisioned_workspaces: number; causes: Record<PendingCause, number>; breaking: string[]; unreadable: string[] };
  ahead: { count: number; modules: string[]; peer: string | null };
}
let pendingCache: { at: number; value: MigrationSummary } | null = null;
export async function pendingMigrationSummary(): Promise<MigrationSummary> {
  if (pendingCache && Date.now() - pendingCache.at < 5_000) return pendingCache.value;
  const rows = await provisionedModuleRows();
  const unprovisioned = await unprovisionedWorkspaceCount();
  const filesByModule = new Map<string, ModuleMigrationFiles>();
  const filesFor = (moduleName: string): ModuleMigrationFiles => {
    const cached = filesByModule.get(moduleName);
    if (cached !== undefined) return cached;
    const files = moduleMigrationFiles(moduleName);
    filesByModule.set(moduleName, files);
    return files;
  };
  // `||`: compose passes an unset variable as "" (docs/architecture/platform-spec.md §14.6).
  const peer = process.env.COBBLR_SHARED_DB_PEER?.trim() || undefined;
  let count = 0;
  const modules = new Set<string>();
  const causes: Record<PendingCause, number> = { own: 0, downgrade: 0, peer_breaking: 0 };
  const breaking = new Set<string>();
  const unreadable = new Set<string>();
  let aheadCount = 0;
  const aheadModules = new Set<string>();
  for (const row of rows) {
    const verdict = healthVerdict(row, filesFor(row.module_name), peer);
    if (verdict === "pending") {
      count++;
      modules.add(row.module_name);
      const cause = pendingCause(row, filesFor(row.module_name), peer);
      if (cause) causes[cause]++;
      if (cause === "peer_breaking" && row.newest_breaking_migration) breaking.add(`${row.module_name}/${row.newest_breaking_migration}`);
      const why = filesFor(row.module_name).unreadable;
      if (why) unreadable.add(why);
    } else if (verdict === "ahead") {
      aheadCount++;
      aheadModules.add(row.module_name);
    }
  }
  const value: MigrationSummary = {
    pending: { count, modules: [...modules].sort(), unprovisioned_workspaces: unprovisioned, causes, breaking: [...breaking].sort(), unreadable: [...unreadable].sort() },
    ahead: { count: aheadCount, modules: [...aheadModules].sort(), peer: peer ?? null },
  };
  pendingCache = { at: Date.now(), value };
  return value;
}

/** Enable the always-on foundational substrate for a fresh org — and
 *  nothing else. Cobblr is a blank slate: every domain module
 *  (inventory, machines, assets, projects, purchases, labels, scan, …)
 *  and every marketplace / user module stays OFF until the user opts
 *  in — from the marketplace ("Browse the marketplace") or
 *  Configuration → Modules. Pre-enabling them would decide the user's
 *  app for them and bury a brand-new workspace under modules and nav
 *  tabs it never asked for. The platform's whole premise is that the
 *  user builds their own app; we don't pre-pick it for them.
 *
 *  Two classes are the exception and get enabled automatically:
 *  - Foundational modules (`band: "foundational"`): the substrate the
 *    kernel + dashboard assume exists (activity-log, files, tags,
 *    locations, notifications, queue, healthcheck, maintenance).
 *  - Capability modules (`autoEnable: true`): ambient plumbing with no
 *    decision content + no side-effects until used (views, search, scan,
 *    ai, recurrence, apps, public-surfaces, …). Asking "enable views?" is
 *    overhead; they just work. Domains (inventory, machines, digifab, …)
 *    stay opt-in — choosing what you *manage* is the one decision worth
 *    surfacing. Sorted so any module that depends on another runs after it.
 */
/** The ledger scope a module's migrations run under in one workspace's
 *  database; the enable and the concurrent pre-pass below must agree on it. */
export function moduleMigrationScope(orgId: string, moduleName: string): string {
  return `tenant ${orgId} / module ${moduleName}`;
}

/** Migrate `names` (and what they depend on) into a workspace's database at
 *  once, ahead of the enables that follow in order: the default modules at
 *  signup, a blueprint's modules when it is applied. Idempotent; a module
 *  already migrated costs one ledger read. */
export async function premigrateModules(orgId: string, names: readonly string[]): Promise<string[][]> {
  const wanted = new Map<string, NonNullable<ReturnType<typeof getEntry>>>();
  const add = (name: string): void => {
    const entry = getEntry(name);
    if (!entry || wanted.has(entry.manifest.name)) return;
    wanted.set(entry.manifest.name, entry);
    for (const d of entry.manifest.dependencies) add(d);
  };
  for (const n of names) add(n);
  if (![...wanted.values()].some((e) => e.manifest.schema)) return [];
  const pool = await getTenantPool(orgId);
  return migrateConcurrently([...wanted.values()], (entry) =>
    runMigrations({ pool, directory: resolve(entry.rootPath, entry.manifest.schema!.migrationsDir), scope: moduleMigrationScope(orgId, entry.manifest.name) }),
  );
}

export async function enableDefaultModulesForOrg(
  orgId: string,
  // Who signed up. Not the actor: the platform turns these on, so the
  // activity log says "Set up for you: Tags", never "You turned on Tags"
  // twenty times for a person who only signed up.
  _signedUpBy?: string,
): Promise<string[]> {
  const enabled: string[] = [];
  const foundationals = listEntries().filter(
    (e) => isDefaultModule(e) && !isTrialDenied(e.manifest.name),
  );

  // Sort foundationals so any with deps run AFTER their deps. (Today
  // every foundational has zero deps; future-proofing for the moment
  // a foundational legitimately depends on another foundational.)
  const sortByDeps = (
    arr: typeof foundationals,
  ): typeof foundationals => {
    const out: typeof foundationals = [];
    const remaining = [...arr];
    const placed = new Set<string>();
    while (remaining.length > 0) {
      const before = remaining.length;
      for (let i = 0; i < remaining.length; i++) {
        const entry = remaining[i]!;
        if (entry.manifest.dependencies.every((d) => placed.has(d))) {
          out.push(entry);
          placed.add(entry.manifest.name);
          remaining.splice(i, 1);
          break;
        }
      }
      if (remaining.length === before) {
        // Cycle / unresolvable dep; bail out and append the rest as-is
        // so we don't infinite-loop. enableModuleForOrg will surface a
        // clearer error.
        out.push(...remaining);
        break;
      }
    }
    return out;
  };

  await premigrateModules(orgId, foundationals.map((e) => e.manifest.name));
  const took: Array<[string, number]> = [];
  for (const entry of sortByDeps(foundationals)) {
    try {
      const at = performance.now();
      const result = await enableModuleForOrg(orgId, entry.manifest.name, {});
      took.push([entry.manifest.name, Math.round(performance.now() - at)]);
      if (!result.alreadyEnabled) enabled.push(entry.manifest.name);
    } catch (err) {
      notePassFailure("enable.defaults", `${orgId}:${entry.manifest.name}`, err);
      console.error(`[enable] failed for ${entry.manifest.name} on org ${orgId}:`, err);
    }
  }
  if (enabled.length) console.log(`[enable] defaults for ${orgId}, slowest: ${took.sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, ms]) => `${n} ${ms}ms`).join(", ")}`);
  return enabled;
}

/** Self-heal: ensure EVERY workspace has the current foundational + autoEnable
 *  capability set. A workspace created before a capability existed never got it
 *  (signup only enables what existed then), so any table that capability owns is
 *  missing — surfacing later as `relation "<x>" does not exist` (e.g.
 *  core-devices owns `core_devices_connections`, so an old workspace 500s on any
 *  connection op). Runs at boot, idempotent: an org already holding all defaults
 *  costs ONE in-memory check and opens no tenant pool; only orgs genuinely
 *  missing a capability open their pool + migrate. Boot-time, so pools are
 *  evicted unconditionally after each heal. */
export async function reconcileDefaultModules(): Promise<{ orgsHealed: number; modulesAdded: number }> {
  // One rule for what a workspace is born with, the one signup uses: a
  // foundational flag off the curated list is not a default, and counting it
  // here opened every workspace's pool on every boot for a module signup
  // would never enable.
  const wanted = listEntries().filter(isDefaultModule).map((e) => e.manifest.name);
  if (wanted.length === 0) return { orgsHealed: 0, modulesAdded: 0 };

  // A claim on a module every workspace is born with means nothing, and one a
  // bundle recorded while the module was still optional is worse: uninstalling
  // that bundle would turn off a module the workspace must have. One meta
  // delete, no tenant pool. enableModuleForOrg records no such claim from here on.
  await meta.deleteFrom("bundle_resource_claims").where("resource_type", "=", "module").where("resource_key", "in", wanted).execute();

  // Skip orgs that were never provisioned (no tenant credentials): enabling
  // anything on them can only throw "has not been provisioned yet" — which one
  // half-provisioned org did, 17 modules' worth, on EVERY staging boot. Signup
  // provisioning owns finishing (or cleaning up) those rows; the reconcile's
  // job is healing orgs that CAN be healed.
  const orgs = await meta
    .selectFrom("orgs")
    .select("id")
    .where("db_credentials_encrypted", "is not", null)
    .execute();
  const rows = await meta.selectFrom("org_modules").select(["org_id", "module_name"]).execute();
  const byOrg = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = byOrg.get(r.org_id);
    if (!s) { s = new Set(); byOrg.set(r.org_id, s); }
    s.add(r.module_name);
  }

  let orgsHealed = 0;
  let modulesAdded = 0;
  for (const org of orgs) {
    const have = byOrg.get(org.id) ?? new Set<string>();
    if (wanted.every((m) => have.has(m))) continue; // complete — no tenant pool opened
    try {
      const added = await enableDefaultModulesForOrg(org.id);
      if (added.length) {
        orgsHealed++;
        modulesAdded += added.length;
        console.log(`[reconcile] org ${org.id}: enabled ${added.join(", ")}`);
      }
    } catch (err) {
      notePassFailure("reconcileDefaultModules", org.id, err);
      console.error(`[reconcile] default-module heal failed for org ${org.id}:`, err);
    } finally {
      await evictTenantPool(org.id).catch(() => {});
    }
  }
  return { orgsHealed, modulesAdded };
}
