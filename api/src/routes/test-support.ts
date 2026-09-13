// TEST-ONLY endpoints for the pre-provisioned org pool. This router is mounted
// in server.ts ONLY when COBBLR_TEST_ORG_POOL is set — it is NOT reachable in
// prod (checkout-org mints a token for a pooled org's owner, so it must never
// exist outside CI / the rig). See db/test-org-pool.ts.
import { Router } from "express";
import { checkoutTestOrg, poolStatus } from "../db/test-org-pool.js";
import { retireReceiptFailurePlaceholders } from "../platform/retire-receipt-failure-placeholders.js";
import { migrateBookshelfToInstance } from "../platform/migrate-bookshelf-to-instance.js";
import { retireGroceriesBaseKindTwin } from "../platform/migrate-groceries-twin-to-instance.js";
import { rehomeAssetsInstanceToRecords } from "../platform/rehome-instance.js";
import { setSubscriberDelayForTests } from "../platform/events.js";
import { registerHandler } from "../platform/actions.js";
import { ActionRefusal } from "@cobblr/platform-contract";
import { meta, metaPool } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import { sql } from "kysely";

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

// Same reason, for the pass that retires the Groceries base-kind twin (#2860).
testSupportRouter.post("/test-support/run-migration/groceries-twin", async (_req, res, next) => {
  try {
    res.json(await retireGroceriesBaseKindTwin({ force: true }));
  } catch (err) {
    next(err);
  }
});

// Same reason, for the pass that moves a failed receipt's placeholder row into
// the session's read state (#2898). Scoped to one org so a test proves the
// pass on the placeholder it seeded and touches nobody else's workspace.
testSupportRouter.post("/test-support/run-migration/receipt-placeholders", async (req, res, next) => {
  try {
    const { org_id } = (req.body ?? {}) as { org_id?: string };
    res.json(await retireReceiptFailurePlaceholders(org_id ? { onlyOrgId: org_id } : {}));
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

// Stretch the gap between ONE org's emit of ONE event and its direct
// subscribers, so a consequence test can make a race certain instead of
// waiting for runner load to expose it (#2839: an undo pressed right after an
// attach found no purchase to void because the subscriber had not run yet).
// Body: { event, org_id, ms }; ms 0 clears it. Scoped so nothing else sharing
// this api process is slowed. Test-only, mounted under the same flag.
testSupportRouter.post("/test-support/subscriber-delay", (req, res) => {
  const { event, org_id, ms } = (req.body ?? {}) as { event?: string; org_id?: string; ms?: number };
  if (!event || !org_id || typeof ms !== "number") {
    res.status(400).json({ error: { code: "bad_body", message: "event + org_id + ms required" } });
    return;
  }
  setSubscriberDelayForTests({ event, orgId: org_id, ms });
  res.json({ ok: true, event, org_id, ms });
});

// Hold ONE tenant connection in a query for `ms`, so a test can have a request
// genuinely mid-flight on a workspace while something happens to that
// workspace's backends (#2957: the api exited on an unhandled pg 'error'
// after a throwaway workspace was deleted under it). Answers 200 when the
// sleep finishes, and the ordinary 500 when the backend was terminated under
// it, which is the answer the test expects. Body: { org_id, ms }.
testSupportRouter.post("/test-support/hold-tenant", async (req, res, next) => {
  try {
    const { org_id, ms } = (req.body ?? {}) as { org_id?: string; ms?: number };
    if (!org_id || typeof ms !== "number" || ms < 0 || ms > 60_000) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id + ms (0..60000) required" } });
      return;
    }
    const db = await getTenantDb(org_id);
    await sql`select pg_sleep(${ms / 1000})`.execute(db);
    res.json({ ok: true, held_ms: ms });
  } catch (err) {
    next(err);
  }
});

// How many backends ONE org's tenant database has right now, and how many of
// them are inside a pg_sleep: the positive control for the two routes around
// it, so a test can prove its held request is on a backend before it acts.
// Query: ?org_id=.
testSupportRouter.get("/test-support/tenant-backends", async (req, res, next) => {
  try {
    const orgId = typeof req.query.org_id === "string" ? req.query.org_id : "";
    if (!orgId) {
      res.status(400).json({ error: { code: "bad_query", message: "org_id required" } });
      return;
    }
    const org = await meta.selectFrom("orgs").select("db_name").where("id", "=", orgId).executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "not_found", message: "no such org" } });
      return;
    }
    const r = await metaPool.query<{ backends: number; sleeping: number }>(
      `SELECT count(*)::int AS backends,
              count(*) FILTER (WHERE state = 'active' AND query ILIKE '%pg_sleep%')::int AS sleeping
         FROM pg_stat_activity WHERE datname = $1`,
      [org.db_name],
    );
    res.json(r.rows[0] ?? { backends: 0, sleeping: 0 });
  } catch (err) {
    next(err);
  }
});

// Terminate every backend of ONE org's tenant database from a second
// connection (the meta pool), the way a workspace deletion, a DBA or a
// restart does. Answers how many were terminated so the test can prove it hit
// something rather than passing on an empty set. Body: { org_id }.
testSupportRouter.post("/test-support/terminate-tenant-backends", async (req, res, next) => {
  try {
    const { org_id } = (req.body ?? {}) as { org_id?: string };
    if (!org_id) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id required" } });
      return;
    }
    const org = await meta.selectFrom("orgs").select("db_name").where("id", "=", org_id).executeTakeFirst();
    if (!org) {
      res.status(404).json({ error: { code: "not_found", message: "no such org" } });
      return;
    }
    // The terminate goes in the SELECT list, never the WHERE: Postgres does not
    // promise the order it evaluates predicates in, and a volatile
    // pg_terminate_backend(pid) reached before `datname = $1` terminates every
    // backend in the cluster, this one included (it did, on the first run).
    const r = await metaPool.query<{ ok: boolean }>(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [org.db_name],
    );
    res.json({ terminated: r.rows.filter((row) => row.ok).length });
  } catch (err) {
    next(err);
  }
});

// An action whose handler THROWS, so a test can prove what the invoke route
// answers for a handler failure: `result.ok:false` with the handler's own
// sentence, never a bare 500 (#2847). The row is registered on demand under
// the test-support module name; the boot sync removes it, since no manifest
// declares it. Test-only, mounted under the same flag.
// Two stubs: one REFUSES (an ActionRefusal, words for the person, repeated
// verbatim) and one CRASHES (a plain Error whose message is a database's,
// answered with the generic sentence and a reference, never the SQL).
export const REFUSING_ACTION_ID = "test-support:refuses";
export const REFUSAL_SENTENCE = "the stub handler refused on purpose";
export const CRASHING_ACTION_ID = "test-support:crashes";
export const CRASH_MESSAGE = 'relation "test_support_missing" does not exist';
async function ensureStubAction(id: string, handlerKey: string, label: string): Promise<void> {
  await meta
    .insertInto("entity_actions")
    .values({
      id,
      module_name: "test-support",
      label,
      description: "A stub handler for the invoke route's own test.",
      icon: null,
      applies_to: sql`${JSON.stringify({ any: true })}::jsonb`,
      scope: "entity",
      invoke_route: null,
      invoke_handler: handlerKey,
      user_invokable: false,
      args_schema: null,
      undoable: false,
      examples: sql`${JSON.stringify([])}::jsonb`,
      position: 0,
      face: null,
      internal: true,
    })
    .onConflict((b) => b.column("id").doUpdateSet({ invoke_handler: handlerKey }))
    .execute();
}
testSupportRouter.post("/test-support/throwing-action", async (_req, res, next) => {
  try {
    registerHandler("test-support.refuses", async () => {
      throw new ActionRefusal(REFUSAL_SENTENCE);
    });
    registerHandler("test-support.crashes", async () => {
      throw new Error(CRASH_MESSAGE);
    });
    await ensureStubAction(REFUSING_ACTION_ID, "test-support.refuses", "Refuse");
    await ensureStubAction(CRASHING_ACTION_ID, "test-support.crashes", "Crash");
    res.json({
      ok: true,
      refuses: { action_id: REFUSING_ACTION_ID, sentence: REFUSAL_SENTENCE },
      crashes: { action_id: CRASHING_ACTION_ID, message: CRASH_MESSAGE },
    });
  } catch (err) {
    next(err);
  }
});
