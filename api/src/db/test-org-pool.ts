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
import { createAccount } from "../platform/accounts.js";
import { sql } from "kysely";
import { env } from "../env.js";
import { hashPassword } from "../auth/password.js";
import { signSession } from "../auth/jwt.js";
import { provisionOrgForUser } from "../routes/auth.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { USER_SOURCE } from "../platform/bundle-claims.js";
import { listEntries } from "../modules/registry.js";
import { isDefaultModule } from "../modules/enable.js";

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
 *  the internal twin of the test harness's enableAllModulesForTests, down to
 *  the 'user' claim the harness's door records: without it a pooled org's
 *  modules were unpinned and a bundle uninstall could switch one off, where
 *  a fresh signup's stayed on (the parity test's first catch, #3268). */
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
        await enableModuleForOrg(orgId, name, { claimedBy: USER_SOURCE });
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
  const userRow = { id: await createAccount(meta, { email, password_hash, display_name: `pool ${suffix}` }, { via: "pool" }) };
  const { orgId, slug } = await provisionOrgForUser(userRow.id, `pool ${suffix}`, { template: "all" });
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
    // 'available' is the bake's word, never the column's default ('unbaked',
    // migration 178): a row a test writes is never handed to another test.
    .values({ org_id: orgId, slug, owner_user_id: userRow.id, status: "available" })
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

/** How many pooled orgs an ordinary checkout leaves in the pool for the one
 *  test that cannot take a fresh signup instead: the parity test compares a
 *  workspace that EXISTED AT BOOT (and so went through every boot pass) with
 *  one born in the run, and a pool that ran out an hour earlier would hand
 *  it nothing to compare, by the same accident of ordering it exists to
 *  catch (#3268). Two, so a retry of that one test still has one. */
export const POOL_RESERVE = 2;

/** Atomically claim one available org (race-safe across the 8 test forks) and
 *  mint its owner a token. Returns null when the pool is empty → the caller
 *  falls back to real provisioning. An ordinary checkout stops short of the
 *  last POOL_RESERVE orgs; `reserved: true` is the parity test's door to
 *  them. */
export async function checkoutTestOrg(opts: { reserved?: boolean } = {}): Promise<CheckoutResult | null> {
  if (!poolEnabled()) return null;
  // `offset` counts unlocked rows only (SKIP LOCKED runs before it), so two
  // ordinary claimers racing on the last three orgs each see one candidate
  // past the reserve at most, and the reserve is never eaten by a race.
  const skip = opts.reserved ? 0 : POOL_RESERVE;
  // The join is the SELF-HEAL: a pool baked before the guard above can still
  // hold orgs whose tenant DB never landed, and that artifact is reused across
  // runs. Skipping them here means an already-poisoned pool degrades to "fewer
  // pooled orgs" (the caller falls back to real provisioning) instead of
  // 503ing whichever test happened to draw one.
  const claimed = await sql<{ org_id: string; slug: string; owner_user_id: string }>`
    update test_org_pool set status = 'taken'
    where status = 'available' and org_id = (
      select p.org_id from test_org_pool p
      join orgs o on o.id = p.org_id
      where p.status = 'available' and o.db_credentials_encrypted is not null
      order by p.baked_at limit 1 offset ${skip} for update of p skip locked
    )
    returning org_id, slug, owner_user_id
  `.execute(meta);
  const row = claimed.rows[0];
  if (!row) return null;
  // Checkout models a signup now, rather than the older workspace baked into
  // the image. Reset only this new-workspace default on the unclaimed fixture;
  // production upgrades must keep every existing workspace opted out.
  await sql`update orgs set main_currency = default, warranty_reminders = default, members_may_lend = default, members_lend_asked = default, low_stock_alerts = default where id = ${row.org_id}`.execute(meta);

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
  // A form sign-up records its arrival (a signed_up product event, with the
  // source its link carried: none, for a test). The pool stands in for that
  // sign-up, so a handed-out org carries the same row, written here rather
  // than at bake so a pool baked before the event existed carries it too.
  // Written directly, not through the fire-and-forget tracker, so it is
  // there before the test's first read. Idempotent.
  try {
    const has = await meta
      .selectFrom("product_events")
      .select("id")
      .where("org_id", "=", row.org_id)
      .where("event", "=", "signed_up")
      .executeTakeFirst();
    if (!has) {
      // check-then-insert: the test pool's own setup: one writer per pooled org, inside its own catch
      await meta
        .insertInto("product_events")
        .values({ org_id: row.org_id, user_id: row.owner_user_id, event: "signed_up", detail: sql`${JSON.stringify({ via: "form", source: null })}::jsonb` })
        .execute();
    }
  } catch (err) {
    console.warn(`[test-org-pool] signed_up for ${row.slug} skipped:`, err);
  }
  // The same at-handout self-heal for the 'user' claim: a pool baked before
  // the bake learned to claim (2026-09-22) hands out orgs whose chosen modules
  // are unpinned, so a bundle uninstall in a test could switch one off where
  // it stays on for a fresh signup. Every enabled module outside the set a
  // workspace is born with gets the claim the harness's enable door records.
  // Idempotent (ON CONFLICT DO NOTHING); one statement.
  try {
    const chosen = listEntries()
      .filter((e) => !isDefaultModule(e))
      .map((e) => e.manifest.name);
    if (chosen.length) {
      await sql`
        insert into bundle_resource_claims (org_id, source, resource_type, resource_key)
        select org_id, ${USER_SOURCE}, 'module', module_name from org_modules
        where org_id = ${row.org_id} and module_name in (${sql.join(chosen)})
        on conflict do nothing
      `.execute(meta);
    }
  } catch (err) {
    console.warn(`[test-org-pool] user claims for ${row.slug} skipped:`, err);
  }
  const token = await signSession(row.owner_user_id);
  return { token, userId: row.owner_user_id, orgId: row.org_id, slug: row.slug };
}

/** The pool's counts, and `fresh`: workspaces that are not the pool's (a sign-up that found it dry provisioned
 *  its own). Read before and after a suite, the difference is the suite's fallbacks (scripts/ci/pool-demand.mjs). */
export async function poolStatus(): Promise<{ available: number; taken: number; total: number; fresh: number }> {
  if (!env.COBBLR_TEST_ORG_POOL) return { available: 0, taken: 0, total: 0, fresh: 0 };
  const rows = await meta
    .selectFrom("test_org_pool")
    .select(["status"])
    .select(meta.fn.countAll().as("n"))
    .groupBy("status")
    .execute();
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const available = by.available ?? 0;
  const taken = by.taken ?? 0;
  const fresh = await sql<{ n: string }>`select count(*)::text as n from orgs o where not exists (select 1 from test_org_pool p where p.org_id = o.id)`.execute(meta);
  return { available, taken, total: available + taken, fresh: Number(fresh.rows[0]?.n ?? 0) };
}
