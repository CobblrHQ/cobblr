// TEST-ONLY pre-provisioned org pool. The integration suite creates hundreds of
// orgs and provisioning them (signup + enable ~29 modules each) is ~63% of CI
// runtime. Instead, bake a pool of ready orgs ONCE (offline / at boot) and have
// signupFreshOrg CHECK ONE OUT — a claim + a token, no provisioning on the test
// critical path.
//
// Entirely gated on COBBLR_TEST_ORG_POOL. Prod / staging / the hosted service never set
// it, so nothing here runs there (the checkout route isn't even registered, the
// table stays empty). CI + the test rig are the only callers.
//
// Faithfulness: the bake provisions each org through the SAME code paths the
// live signup uses — create user → provisionOrgForUser (org + tenant DB +
// foundational modules) → enableModuleForOrg for the rest — so a pooled org is
// indistinguishable from one signupFreshOrg makes today. A checked-out org is
// single-use (tests mutate it) and torn down by the file's afterAll as normal.

import { meta } from "./meta.js";
import { sql } from "kysely";
import { env } from "../env.js";
import { hashPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";
import { provisionOrgForUser } from "../routes/auth.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { listEntries } from "../modules/registry.js";

/** The pool is active only under the flag. A hard guard against ever touching
 *  this in prod (the checkout route mints tokens — it must be unreachable). */
export function poolEnabled(): boolean {
  if (!env.COBBLR_TEST_ORG_POOL) return false;
  if (env.NODE_ENV === "production" && !env.COBBLR_ENV) {
    // belt-and-suspenders: refuse the pool on a real prod node even if the flag
    // leaked into the environment. (Staging/prod set COBBLR_ENV; a bare
    // NODE_ENV=production with the flag set is a misconfig we won't honour.)
    throw new Error("COBBLR_TEST_ORG_POOL must never be set on a production node");
  }
  return true;
}

/** Enable every registered module for an org, in dependency-safe waves —
 *  the internal twin of the test harness's enableAllModulesForTests. */
async function enableAllModulesInternal(orgId: string): Promise<void> {
  const already = new Set(
    (await meta.selectFrom("org_modules").select("module_name").where("org_id", "=", orgId).execute()).map(
      (r) => r.module_name,
    ),
  );
  let remaining = listEntries()
    .map((e) => e.manifest.name)
    .filter((n) => !already.has(n));
  for (let wave = 0; wave < 10 && remaining.length > 0; wave++) {
    const failed: string[] = [];
    for (const name of remaining) {
      try {
        await enableModuleForOrg(orgId, name);
      } catch {
        failed.push(name); // usually an unmet dep — retry next wave
      }
    }
    if (failed.length === remaining.length) break; // no progress
    remaining = failed;
  }
}

/** Provision ONE pool org through the real signup code path + record it. */
async function bakeOneOrg(index: number): Promise<void> {
  const suffix = index.toString(36).padStart(4, "0");
  const email = `pool-${suffix}-${Date.now().toString(36)}@cobblr-test.local`;
  const password_hash = await hashPassword("pool-org-not-secret-1234");
  const userRow = await meta
    .insertInto("users")
    .values({ email, password_hash, display_name: `pool ${suffix}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  const { orgId, slug } = await provisionOrgForUser(userRow.id, `pool ${suffix}`);
  // Signup RETURNS SUCCESSFULLY even when tenant provisioning failed — the org
  // row is deliberately kept so an operator can re-provision (see the 503 in
  // middleware/tenant.ts). So a bare "it didn't throw" is not proof the org is
  // usable, and trusting it is how a dead org entered the pool, got baked into
  // the reusable artifact, and 503'd `tenant_unprovisioned` on every run that
  // checked it out afterwards — reddening main and every PR branch alike
  // (2026-08-08). Verify the thing that actually matters before advertising it.
  const provisioned = await meta
    .selectFrom("orgs")
    .select("db_credentials_encrypted")
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!provisioned?.db_credentials_encrypted) {
    throw new Error(`pool org ${slug} provisioned without tenant credentials — not pooling it`);
  }
  await enableAllModulesInternal(orgId);
  await meta
    .insertInto("test_org_pool")
    .values({ org_id: orgId, slug, owner_user_id: userRow.id })
    .execute();
}

/** Bake up to `target` orgs (skips work already present). Concurrency-capped so
 *  the box isn't hammered but many provisions overlap. Idempotent-ish: only
 *  fills the gap to `target`. */
export async function bakeTestOrgPool(target: number): Promise<{ baked: number; total: number }> {
  if (!poolEnabled()) return { baked: 0, total: 0 };
  // Retire any pooled org whose tenant DB never landed BEFORE counting, so the
  // top-up below actually replaces them rather than counting corpses as stock.
  const quarantined = await sql<{ org_id: string }>`
    update test_org_pool set status = 'broken'
    where status <> 'broken'
      and org_id in (select id from orgs where db_credentials_encrypted is null)
    returning org_id
  `.execute(meta);
  if (quarantined.rows.length) {
    console.warn(
      `[test-org-pool] quarantined ${quarantined.rows.length} unprovisioned org(s) — they will be re-baked`,
    );
  }
  const have = Number(
    (
      await meta
        .selectFrom("test_org_pool")
        .select(meta.fn.countAll().as("n"))
        .where("status", "<>", "broken")
        .executeTakeFirstOrThrow()
    ).n,
  );
  const need = Math.max(0, target - have);
  if (need === 0) return { baked: 0, total: have };

  const CAP = 10;
  let next = 0;
  let baked = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= need) return;
      try {
        await bakeOneOrg(have + i);
        baked++;
      } catch (err) {
        console.error("[test-org-pool] bake failed:", (err as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CAP, need) }, worker));
  console.log(`[test-org-pool] baked ${baked}/${need} (total now ${have + baked})`);
  return { baked, total: have + baked };
}

export interface CheckoutResult {
  token: string;
  userId: string;
  orgId: string;
  slug: string;
}

/** Atomically claim one available org (race-safe across the 8 test forks) and
 *  mint its owner a token. Returns null when the pool is empty → the caller
 *  falls back to real provisioning. */
export async function checkoutTestOrg(): Promise<CheckoutResult | null> {
  if (!poolEnabled()) return null;
  // The join is the SELF-HEAL: a pool baked before the guard above can still
  // hold orgs whose tenant DB never landed, and that artifact is reused across
  // runs. Skipping them here means an already-poisoned pool degrades to "fewer
  // pooled orgs" (the caller falls back to real provisioning) instead of
  // 503ing whichever test happened to draw one.
  const claimed = await sql<{ org_id: string; slug: string; owner_user_id: string }>`
    update test_org_pool set status = 'taken'
    where org_id = (
      select p.org_id from test_org_pool p
      join orgs o on o.id = p.org_id
      where p.status = 'available' and o.db_credentials_encrypted is not null
      order by p.baked_at limit 1 for update of p skip locked
    )
    returning org_id, slug, owner_user_id
  `.execute(meta);
  const row = claimed.rows[0];
  if (!row) return null;
  // Pooled orgs were provisioned at BAKE time, so they miss anything installed
  // by enable-time hooks added since the bake — concretely the transitional
  // location_id→placement sync triggers (the boot sweep is skipped in CI via
  // COBBLR_SKIP_HISTORICAL_MIGRATIONS, and enableAllModulesForTests never
  // re-enables already-on modules). Ensure them at handout so a checked-out
  // org behaves exactly like a fresh signup. Idempotent, a few cheap queries;
  // test-support only (this route never exists in prod). Best-effort.
  try {
    const { ensurePlacementSyncForOrg } = await import(
      "../platform/migrate-location-to-placement.js"
    );
    await ensurePlacementSyncForOrg(row.org_id);
  } catch (err) {
    console.warn(`[test-org-pool] placement sync for ${row.slug} skipped:`, err);
  }
  const token = await signSession(row.owner_user_id);
  return { token, userId: row.owner_user_id, orgId: row.org_id, slug: row.slug };
}

export async function poolStatus(): Promise<{ available: number; taken: number; total: number }> {
  if (!env.COBBLR_TEST_ORG_POOL) return { available: 0, taken: 0, total: 0 };
  const rows = await meta
    .selectFrom("test_org_pool")
    .select(["status"])
    .select(meta.fn.countAll().as("n"))
    .groupBy("status")
    .execute();
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const available = by.available ?? 0;
  const taken = by.taken ?? 0;
  return { available, taken, total: available + taken };
}
