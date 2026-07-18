// TEST-ONLY endpoints for the pre-provisioned org pool. This router is mounted
// in server.ts ONLY when COBBLR_TEST_ORG_POOL is set — it is NOT reachable in
// prod (checkout-org mints a token for a pooled org's owner, so it must never
// exist outside CI / the rig). See db/test-org-pool.ts.
import { Router } from "express";
import { checkoutTestOrg, poolStatus } from "../db/test-org-pool.js";
import { migrateBookshelfToInstance } from "../platform/migrate-bookshelf-to-instance.js";
import { rehomeAssetsInstanceToRecords } from "../platform/rehome-instance.js";

export const testSupportRouter = Router();

// Claim one ready org and get its owner a token. 409 when the pool is empty →
// the harness falls back to real provisioning.
testSupportRouter.post("/test-support/checkout-org", async (_req, res, next) => {
  try {
    const org = await checkoutTestOrg();
    if (!org) {
      res.status(409).json({ error: { code: "pool_exhausted", message: "test org pool empty" } });
      return;
    }
    res.json(org); // { token, orgId, slug }
  } catch (err) {
    next(err);
  }
});

// Poll target during the boot bake: { available, taken, total }.
testSupportRouter.get("/test-support/pool-status", async (_req, res, next) => {
  try {
    res.json(await poolStatus());
  } catch (err) {
    next(err);
  }
});

// Run ONE historical migration on demand, so its integration test can exercise
// it where it actually lives — IN the api process. A test process has no module
// registry (it never calls loadAllModules), so calling a pass that provisions an
// instance straight from a test dies on "Module 'inventory' isn't registered" —
// which is how this endpoint came to exist. `force` bypasses the job-wide
// COBBLR_SKIP_HISTORICAL_MIGRATIONS the suite sets for boot.
//
// Named per-migration on purpose: a blanket "run all historical passes" would
// sweep every OTHER test's pooled org, which is the exact thing that skip flag
// is there to prevent. Test-only — this router is mounted only when
// COBBLR_TEST_ORG_POOL is set (see the header).
testSupportRouter.post("/test-support/run-migration/bookshelf", async (_req, res, next) => {
  try {
    res.json(await migrateBookshelfToInstance({ force: true }));
  } catch (err) {
    next(err);
  }
});

// Re-home ONE assets instance onto the records substrate — lets the rehome's
// integration test exercise the real code path in the api process (same reason
// as the bookshelf endpoint above). Body: { org_id, instance }.
testSupportRouter.post("/test-support/rehome-instance", async (req, res, next) => {
  try {
    const { org_id, instance } = (req.body ?? {}) as { org_id?: string; instance?: string };
    if (!org_id || !instance) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id + instance required" } });
      return;
    }
    res.json(await rehomeAssetsInstanceToRecords(org_id, instance));
  } catch (err) {
    next(err);
  }
});
