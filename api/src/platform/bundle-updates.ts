// PERMANENT RECONCILE — installed bundles catch up to the catalog on their own.
//
// The patch/minor auto-apply lived in the dashboard: each update row fired an
// install when it MOUNTED, once per tab. So a workspace whose owner never
// opens Home never updated, two tabs raced the same install, and six bundles
// "magically" updated in front of the one person who happened to visit
// (2026-09-09). An update that waits for somebody to look at a page is a stale
// install with a countdown nobody can see. Updates must self-heal.
//
// The rule is unchanged and lives in the contract (bundle-update-tier.ts):
//   patch  → apply silently, audited by the bundle_installed activity entry
//   minor  → apply
//   major / non-semver / downgrade / anything that ships catalogs → never on
//            its own; the dashboard keeps the explicit prompt
// and the safety gates are the ones the row used: validate first, and leave
// for the prompt anything that needs a module enabled, collides on a field,
// or reports an upgrade conflict. The apply itself is applyValidatedBundle,
// the same function the install route calls, attributed to the workspace's
// owner with auth_method "system".
//
// Cheap on the happy path: one meta query lists every installed bundle across
// workspaces, the plan is pure and in memory, and a tenant pool opens only
// when something actually applies - and is evicted after.

import {
  classifyBundleUpdate,
  isDowngradeOrSame,
  tierAutoApplies,
  updateMayTeardownCatalogs,
  type BundleUpdateTier,
} from "@cobblr/platform-contract/bundle-update-tier";
import { listFlagshipManifests } from "../lib/flagship-bundles.js";
import { runExclusive } from "./exclusive.js";

export interface InstalledBundle {
  org_id: string;
  external_id: string;
  version: string;
  manifest: unknown;
  enabled_features: string[];
}

export interface CatalogEntry {
  id: string;
  version: string;
  manifest: unknown;
}

export interface PlannedUpdate {
  orgId: string;
  externalId: string;
  from: string;
  to: string;
  tier: BundleUpdateTier;
  manifest: unknown;
  enabledFeatures: string[];
}

/**
 * Which installed bundles apply on their own. Pure, so the rule is testable
 * without a database: patch and minor, never a downgrade, never a bundle that
 * ships catalogs on either side (an update that could tear a catalog down is
 * a decision, not a heal). The person's enabled features ride along, so an
 * update never re-enables a default they turned off.
 */
export function planBundleUpdates(installed: InstalledBundle[], catalog: CatalogEntry[]): PlannedUpdate[] {
  const latest = new Map(catalog.map((c) => [c.id, c]));
  const out: PlannedUpdate[] = [];
  for (const b of installed) {
    const cat = latest.get(b.external_id);
    if (!cat || cat.version === b.version) continue;
    if (isDowngradeOrSame(b.version, cat.version)) continue;
    if (updateMayTeardownCatalogs(b.manifest, cat.manifest)) continue;
    const tier = classifyBundleUpdate(b.version, cat.version);
    if (!tierAutoApplies(tier)) continue;
    out.push({ orgId: b.org_id, externalId: b.external_id, from: b.version, to: cat.version, tier, manifest: cat.manifest, enabledFeatures: b.enabled_features ?? [] });
  }
  return out;
}

/** The catalog the server knows: the flagship manifests shipped in the image.
 *  A registry-only bundle is not here and stays on the dashboard's prompt. */
function serverCatalog(): CatalogEntry[] {
  return listFlagshipManifests("all")
    .map((m) => ({ id: String(m.id ?? ""), version: String((m as { version?: unknown }).version ?? ""), manifest: m }))
    .filter((c) => c.id && c.version);
}

/** Apply every planned update across workspaces. Per-workspace try/catch;
 *  one failure never blocks the rest. */
export async function reconcileBundleUpdates(): Promise<{ planned: number; applied: number; skipped: number }> {
  // More than one api runs against one database (canary, a rolling deploy).
  // Two of them applying the same update at once is two installs racing one
  // row, so only one process does a sweep at a time; the loser reports
  // nothing planned and comes round again next hour.
  let out = { planned: 0, applied: 0, skipped: 0 };
  await runExclusive("bundle-updates", async () => {
    out = await reconcileBundleUpdatesInner();
  });
  return out;
}

async function reconcileBundleUpdatesInner(): Promise<{ planned: number; applied: number; skipped: number }> {
  const { meta } = await import("../db/meta.js");
  const { validateBundle, applyValidatedBundle } = await import("../routes/bundles.js");
  const { evictTenantPool } = await import("../db/tenant.js");

  const rows = await meta
    .selectFrom("bundles")
    .select(["org_id", "external_id", "version", "manifest", "enabled_features"])
    .where("install_status", "=", "active")
    .execute();
  const plan = planBundleUpdates(
    rows.map((r) => ({ ...r, enabled_features: (r.enabled_features as string[] | null) ?? [] })),
    serverCatalog(),
  );
  let applied = 0;
  let skipped = 0;
  const byOrg = new Map<string, PlannedUpdate[]>();
  for (const p of plan) byOrg.set(p.orgId, [...(byOrg.get(p.orgId) ?? []), p]);

  for (const [orgId, updates] of byOrg) {
    try {
      const owner = await meta
        .selectFrom("org_memberships")
        .innerJoin("users", "users.id", "org_memberships.user_id")
        .select(["users.id as id", "users.display_name as display_name"])
        .where("org_memberships.org_id", "=", orgId)
        .where("org_memberships.role", "=", "owner")
        .orderBy("org_memberships.joined_at", "asc")
        .executeTakeFirst();
      if (!owner) { skipped += updates.length; continue; }
      for (const u of updates) {
        try {
          // The same gates the dashboard row applied before it pressed anything.
          const v = await validateBundle(orgId, u.manifest, { autoEnable: false, enabledFeatures: u.enabledFeatures });
          const blocked =
            !v.valid ||
            v.errors.some((e) => e.code === "needs_enable" || e.code === "field_def_collision") ||
            (v.preview?.upgrade_conflicts?.length ?? 0) > 0;
          if (blocked) { skipped++; continue; }
          await applyValidatedBundle(orgId, { id: owner.id, display_name: owner.display_name ?? null, auth_method: "system" }, v);
          applied++;
          console.log(`[bundle-updates] org ${orgId}: ${u.externalId} ${u.from} → ${u.to} (${u.tier})`);
        } catch (err) {
          skipped++;
          console.error(`[bundle-updates] org ${orgId}: ${u.externalId} failed:`, (err as Error).message);
        }
      }
    } finally {
      await evictTenantPool(orgId).catch(() => {});
    }
  }
  return { planned: plan.length, applied, skipped };
}

const HOUR = 60 * 60 * 1000;

/** Boot runs it once; this keeps it running, so a catalog that moved with a
 *  deploy reaches every workspace within the hour, not when somebody looks. */
export function startBundleUpdateSweeper(): void {
  // SINGLE-PROCESS-SAFE: the tick runs through runExclusive("bundle-updates"), so
  // two api processes never apply the same update at once.
  const tick = () => {
    reconcileBundleUpdates().catch((err) => console.error("[bundle-updates] sweep failed:", (err as Error).message));
  };
  setInterval(tick, HOUR).unref();
}
