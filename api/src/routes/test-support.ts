import { invalidateRateCache } from "../platform/money.js";
// TEST-ONLY endpoints for the pre-provisioned org pool. This router is mounted
// in server.ts ONLY when COBBLR_TEST_ORG_POOL is set — it is NOT reachable in
// prod (checkout-org mints a token for a pooled org's owner, so it must never
// exist outside CI / the rig). See db/test-org-pool.ts.
import { Router } from "express";
import { checkoutTestOrg, poolStatus } from "../db/test-org-pool.js";
import { workspaceShape } from "../db/workspace-shape.js";
import { clearPassFailures, passFailures } from "../platform/pass-failures.js";
import { retireReceiptFailurePlaceholders } from "../platform/retire-receipt-failure-placeholders.js";
import { healBundleViewFields } from "../platform/heal-bundle-view-fields.js";
import { rehomeAssetsInstanceToRecords } from "../platform/rehome-instance.js";
import { reconcileScanCategoryFields, retireScanCategoryPlaceholders } from "../platform/reconcile-scan-category.js";
import { runAllTenantSweeps, runTenantSweep } from "../platform/tenant-sweeps.js";
import { testSweepRound } from "./test-support-sweep-round.js";
import { on, setSubscriberDelayForTests } from "../platform/events.js";
import { selfFetch } from "../platform/self-fetch.js";
import { runWithActor } from "../lib/request-context.js";
import { type ApplyPoint, mirrorApplyHoldReached, setMirrorApplyHoldForTests } from "../platform/share-mirror.js";
import * as notifications from "../platform/notifications.js";
import { registerHandler } from "../platform/actions.js";
import { issueUndos } from "../platform/issued-undos.js";
import { ActionRefusal, PLATFORM_OWNER } from "@cobblr/platform-contract";
import { meta, metaPool } from "../db/meta.js";
import { getTenantDb, tenantPoolStats } from "../db/tenant.js";
import { poolCounts } from "../db/pool-stats.js";
import { readProbe } from "../platform/meta-probe.js";
import { poolHolders, poolPeak } from "../db/client-error-guard.js";
import { forgetOrgInTtlCaches } from "../lib/ttl-cache.js";
import { sql } from "kysely";
import {
  forgetOutboundHold,
  outboundHoldStatus,
  registerOutboundHold,
  releaseOutboundHold,
} from "@cobblr/platform-net";
import { arrivedEverywhere } from "@cobblr/platform-contract";

export const testSupportRouter = Router();

// Claim one ready org and get its owner a token. 409 when the pool is empty →
// the harness falls back to real provisioning.
// `?reserved=1` reaches past the pool's reserve (see POOL_RESERVE): the
// parity test's door, and nobody else's.
testSupportRouter.post("/test-support/checkout-org", async (req, res, next) => {
  try {
    const org = await checkoutTestOrg({ reserved: req.query.reserved === "1" });
    if (!org) {
      res.status(409).json({ error: { code: "pool_exhausted", message: "test org pool empty" } });
      return;
    }
    res.json(org); // { token, orgId, slug }
  } catch (err) {
    next(err);
  }
});

// Run a workspace's heal inside the arrival gap, before its lines are received.
// This forces the overlap a contended runner otherwise hits only sometimes.
const arrivalHeals = new Map<string, { ran: boolean; failed: boolean }>();
on("purchases.order.arrived", "test-support", async (payload) => {
  const orgId = (payload as { orgId: string }).orgId;
  const pending = arrivalHeals.get(orgId);
  if (!pending || pending.ran) return;
  pending.ran = true;
  pending.failed = true;
  const result = await runTenantSweep("purchases.heal-unreceived-arrivals", { orgIds: [orgId] });
  pending.failed = result.visited !== 1 || result.failed > 0 || !!result.skipped;
});
testSupportRouter.post("/test-support/heal-during-arrival", (req, res) => {
  const orgId = req.body?.org_id;
  if (typeof orgId !== "string") {
    res.status(400).json({ error: "org_id required" });
    return;
  }
  arrivalHeals.set(orgId, { ran: false, failed: false });
  res.json({ ok: true });
});
testSupportRouter.delete("/test-support/heal-during-arrival/:orgId", (req, res) => {
  const result = arrivalHeals.get(req.params.orgId!);
  arrivalHeals.delete(req.params.orgId!);
  res.json(result ?? { ran: false, failed: false });
});

// What the heal, reconcile and sweep passes caught (platform/pass-failures.ts),
// so a test that ran a pass can tell "found nothing" from "failed". DELETE
// starts the record over.
testSupportRouter.get("/test-support/pass-failures", (_req, res) => {
  res.json({ failures: passFailures() });
});
testSupportRouter.delete("/test-support/pass-failures", (_req, res) => {
  clearPassFailures();
  res.status(204).end();
});

// What one workspace carries (db/workspace-shape.ts), for the parity test
// that diffs a pooled org against a fresh signup. Reads ONE org, named by the
// caller, and releases its tenant pool on the way out.
testSupportRouter.get("/test-support/workspace-shape", async (req, res, next) => {
  try {
    const orgId = typeof req.query.org_id === "string" ? req.query.org_id : "";
    if (!orgId) {
      res.status(400).json({ error: { code: "org_id_required", message: "org_id names the workspace to read" } });
      return;
    }
    res.json(await workspaceShape(orgId));
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
// is there to prevent. And SCOPED to the caller's org for the same reason: a
// pass that walks every workspace relabels or moves rows in every other
// test's workspace mid-flight (the scan-category door did, 2026-09-20, and
// two unrelated tests failed on ordering). Every door here reads org_id and
// hands its pass { onlyOrgId }; lint:test-support-doors-scoped holds it.
// Test-only — this router is mounted only when COBBLR_TEST_ORG_POOL is set
// (see the header).
const onlyOrg = (req: { body?: unknown }): { onlyOrgId?: string } => {
  const { org_id } = (req.body ?? {}) as { org_id?: string };
  return org_id ? { onlyOrgId: org_id } : {};
};

// Same reason, for the pass that moves a failed receipt's placeholder row into
// the session's read state (#2898). Scoped to one org so a test proves the
// pass on the placeholder it seeded and touches nobody else's workspace.
testSupportRouter.post("/test-support/run-migration/receipt-placeholders", async (req, res, next) => {
  try {
    res.json(await retireReceiptFailurePlaceholders(onlyOrg(req)));
  } catch (err) {
    next(err);
  }
});

// Same reason, for the boot pass that gives every scan fallback table its
// category axis and relabels the axis on a table that keeps its own categories
// (#3148): the words a form shows are decided by the module registry, which
// only the api process has.
testSupportRouter.post("/test-support/run-migration/scan-category-axis", async (req, res, next) => {
  try {
    // Both passes, in boot's order: the axis first, then the retire of a
    // placeholder on a kind that keeps its own taxonomy (boot runs the retire
    // after the module mount, which a running api has long since done).
    await reconcileScanCategoryFields(onlyOrg(req));
    await retireScanCategoryPlaceholders(onlyOrg(req));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Same reason, for the boot pass that gives a bundle-seeded view the shipped
// bundle's definition when the one its install wrote names a field its kind
// lacks (heal-bundle-view-fields.ts).
testSupportRouter.post("/test-support/run-migration/bundle-view-fields", async (req, res, next) => {
  try {
    res.json(await healBundleViewFields(onlyOrg(req)));
  } catch (err) {
    next(err);
  }
});

// Run ONE registered tenant sweep on ONE workspace, now, so a test can press
// the real pass (the expiry sweeper, the arrival sweep) rather than a mirror
// of its rule. Body: { name, org_id, now? }. org_id is REQUIRED for the same
// reason the run-migration doors take it: a pass walks every workspace, and
// 500 other tests hold workspaces in this database. `now` (ISO) is the clock
// the walk hands the pass, so a test can run the heads-up on one day and the
// day-of on a later one (#3349: the day-of line was never pressed because the
// sweeper read the wall clock). The result is the walk's own (visited,
// failed, per-workspace results), so a test can read what the pass itself
// reported for that workspace.
testSupportRouter.post("/test-support/run-sweep", async (req, res, next) => {
  try {
    const { name, org_id, now } = (req.body ?? {}) as { name?: string; org_id?: string; now?: string };
    if (!name || !org_id) {
      res.status(400).json({ error: { code: "bad_request", message: "body needs { name, org_id, now? }" } });
      return;
    }
    const at = now ? new Date(now) : undefined;
    if (at && Number.isNaN(at.getTime())) {
      res.status(400).json({ error: { code: "bad_request", message: "now must be an ISO date" } });
      return;
    }
    res.json(await runTenantSweep(name, { orgIds: [org_id], ...(at ? { now: at } : {}) }));
  } catch (err) {
    next(err);
  }
});

// The late-card pass the boot and "turn Discord on" run, narrowed to the
// caller's own feedback items so a test never posts anybody else's.
// Body: { ids: string[] }.
testSupportRouter.post("/test-support/post-cardless-feedback", async (req, res, next) => {
  try {
    const ids = ((req.body ?? {}) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
      res.status(400).json({ error: { code: "bad_request", message: "body needs { ids: string[] }" } });
      return;
    }
    const { postCardlessFeedback } = await import("./feedback-card-post.js");
    const { announceRouted } = await import("../platform/announce.js");
    // Why each id was or was not posted, so a test that reads "posted: 0"
    // also reads the reason instead of guessing at it.
    const why: Record<string, unknown> = {};
    for (const id of ids as string[]) why[id] = { posted: false, reason: "skipped", message: "Not picked: no such item, not open, or it already has a card." };
    const routed = await announceRouted("feedback.new");
    const posted = await postCardlessFeedback({ onlyIds: ids as string[], onResult: (id, r) => (why[id] = r) });
    res.json({ posted, routed, why });
  } catch (err) {
    next(err);
  }
});

// Put ONE order in the shape the old "Mark arrived" left: status arrived, its
// lines never received. No door makes that shape any more, which is the
// point, so the purchases arrival heal's test builds it here. `flagged` puts
// its lines where the heal's first version left them: stamped received and
// put to a person. Body: { org_id, order_id, arrived_at?, flagged? }.
testSupportRouter.post("/test-support/legacy-order-arrival", async (req, res, next) => {
  try {
    const { org_id, order_id, arrived_at, flagged, status } = (req.body ?? {}) as { org_id?: string; order_id?: string; arrived_at?: string; flagged?: boolean; status?: "ordered" | "arrived" };
    if (!org_id || !order_id) {
      res.status(400).json({ error: { code: "bad_request", message: "body needs { org_id, order_id, arrived_at? }" } });
      return;
    }
    const db = await getTenantDb(org_id);
    await sql`update purchases_orders set status = ${status === 'ordered' ? 'ordered' : 'arrived'}, arrived_at = ${arrived_at ?? arrivedEverywhere(new Date())}::date, updated_at = to_timestamp(0) where id = ${order_id}`.execute(db);
    // Lines the old code wrote: made before the heal's fix merged (#7282).
    await sql`update purchases_order_items set updated_at = to_timestamp(0), created_at = '2026-09-29T00:00:00Z' where order_id = ${order_id}`.execute(db);
    if (flagged) {
      await sql`update purchases_order_items set received_at = ${arrived_at ?? arrivedEverywhere(new Date())}::date, receipt_unconfirmed = true where order_id = ${order_id} and part_id is not null`.execute(db);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Every registered sweep, one round, for ONE workspace: the parity test's
// way to bring a pooled workspace up to "after its heals" before comparing it
// with a new one, whatever the scheduler had reached. Body: { org_id }.
// Answers each pass's own result, and 500 naming any pass whose visit failed.
testSupportRouter.post("/test-support/run-all-sweeps", async (req, res, next) => {
  try {
    const { org_id } = (req.body ?? {}) as { org_id?: string };
    if (!org_id) {
      res.status(400).json({ error: { code: "bad_request", message: "body needs { org_id }" } });
      return;
    }
    const round = await testSweepRound({ all: runAllTenantSweeps }, org_id);
    res.status(round.failed.length ? 500 : 200).json(round);
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

// The api calling itself in-process (self-fetch.ts), from inside a request
// that already has an actor: the inner request must be judged on its own
// Authorization exactly as one off a socket is, never as the outer caller.
// Body: { method, path, authorization?, outer_user_id? }; answers the inner
// response's status and body.
testSupportRouter.post("/test-support/self-fetch", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { method?: string; path?: string; authorization?: string; outer_user_id?: string };
    if (!b.path || !b.path.startsWith("/api/")) {
      res.status(400).json({ error: { code: "bad_body", message: "path (/api/…) required" } });
      return;
    }
    const call = () => selfFetch(b.path!, { method: b.method ?? "GET", headers: b.authorization ? { authorization: b.authorization } : {} });
    const r = b.outer_user_id ? await runWithActor({ userId: b.outer_user_id, authMethod: "session", apiTokenId: null }, call) : await call();
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    res.json({ status: r.status, body });
  } catch (err) {
    next(err);
  }
});

// Hold a share's mirror inside its apply on one share space, before or after
// it writes the owner's change onto the copy, so a test lands the friend's
// edit exactly there (a friend's edit lost to the mirror). Body: { slug (the
// share space), at: "before-write" | "after-write" | "owner-pass" |
// "edits-pass" (the friend's edits pass, holding the copy's state), ms }; ms
// 0 clears. GET
// reports how many applies reached it, the positive control.
testSupportRouter.post("/test-support/mirror-apply-hold", async (req, res, next) => {
  try {
    const { slug, at, ms } = (req.body ?? {}) as { slug?: string; at?: string; ms?: number };
    if (!slug || !["before-write", "after-write", "owner-pass", "edits-pass", "owner-edit-write"].includes(at ?? "") || typeof ms !== "number") {
      res.status(400).json({ error: { code: "bad_body", message: "slug + at (before-write|after-write|owner-pass|edits-pass|owner-edit-write) + ms required" } });
      return;
    }
    const o = await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst();
    if (!o) {
      res.status(404).json({ error: { code: "not_found", message: "no such workspace" } });
      return;
    }
    setMirrorApplyHoldForTests({ orgId: o.id, at: at as ApplyPoint, ms });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// The next `times` edits a share space queues fail inside their write, after
// the edit is queued (#7125). Body: { slug, times }; GET ?slug= reads what is
// left to fail.
// The next runs of one hand-over step fail (#7133): the retry must finish it.
testSupportRouter.post("/test-support/hand-over-fails", async (req, res, next) => {
  try {
    const { slug, step, times } = (req.body ?? {}) as { slug?: string; step?: string; times?: number };
    const o = slug ? await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst() : undefined;
    if (!o || !["receive", "give-away", "bring-back"].includes(step ?? "") || typeof times !== "number") {
      res.status(400).json({ error: { code: "bad_body", message: "slug of a workspace + step (receive|give-away|bring-back) + times required" } });
      return;
    }
    const { failHandOverStepForTests } = await import("../platform/share-offers.js");
    failHandOverStepForTests(o.id, step as "receive" | "give-away" | "bring-back", times);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
// Hold all but `leave` of a workspace's connections for `ms` (#7326), as a
// busy workspace does: two taps must still pay for one term with what is left.
testSupportRouter.post("/test-support/hold-tenant-connections", async (req, res, next) => {
  try {
    const { slug, leave, ms } = (req.body ?? {}) as { slug?: string; leave?: number; ms?: number };
    const o = slug ? await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst() : undefined;
    if (!o || typeof leave !== "number" || typeof ms !== "number") {
      res.status(400).json({ error: { code: "bad_body", message: "slug of a workspace + leave + ms required" } });
      return;
    }
    const { getTenantPool, TENANT_POOL_MAX } = await import("../db/tenant.js");
    const { holdClients } = await import("../db/pool-stats.js");
    const held = await holdClients(await getTenantPool(o.id), Math.max(0, TENANT_POOL_MAX - leave));
    const release = setTimeout(() => held.forEach((c) => c.release()), Math.min(ms, 60_000));
    release.unref?.();
    res.json({ held: held.length, pool_max: TENANT_POOL_MAX });
  } catch (err) {
    next(err);
  }
});
testSupportRouter.post("/test-support/edits-queue-fails", async (req, res, next) => {
  try {
    const { slug, times } = (req.body ?? {}) as { slug?: string; times?: number };
    const o = slug ? await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst() : undefined;
    if (!o || typeof times !== "number") {
      res.status(400).json({ error: { code: "bad_body", message: "slug of a workspace + times required" } });
      return;
    }
    const { failEditsQueueForTests } = await import("../platform/share-edits.js");
    failEditsQueueForTests(o.id, times);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
testSupportRouter.get("/test-support/edits-queue-fails", async (req, res, next) => {
  try {
    const slug = typeof req.query.slug === "string" ? req.query.slug : "";
    const o = await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst();
    const { editsQueueFailuresLeft } = await import("../platform/share-edits.js");
    res.json({ left: o ? editsQueueFailuresLeft(o.id) : 0 });
  } catch (err) {
    next(err);
  }
});

// ?slug=<workspace> reads that workspace's count: holds are per workspace, so
// a test reads its own and never another file's (#5396).
testSupportRouter.get("/test-support/mirror-apply-hold", async (req, res, next) => {
  try {
    const slug = typeof req.query.slug === "string" ? req.query.slug : null;
    if (!slug) {
      res.json({ reached: mirrorApplyHoldReached() });
      return;
    }
    const o = await meta.selectFrom("orgs").select("id").where("slug", "=", slug).executeTakeFirst();
    if (!o) {
      res.status(404).json({ error: { code: "not_found", message: "no such workspace" } });
      return;
    }
    res.json({ reached: mirrorApplyHoldReached(o.id) });
  } catch (err) {
    next(err);
  }
});

// Hold every outbound fetch whose URL contains a substring until the test
// says so, and answer it from a canned response when one is given: a test's
// way to say "this write has not landed yet" (#3119). A detached write is
// detached because it awaits outbound I/O, and every SSRF-guarded fetch goes
// through the one loop in @cobblr/platform-net, so holding the I/O holds the
// write. GET reports `reached` (the positive control: a hold nobody reached
// means nothing was in flight) and `returned`; DELETE releases; DELETE
// ?forget=1 releases and drops the record. Every hold auto-releases at a cap
// (default 30 s, max 120 s) so a test that died never wedges this shared api.
// Body: { includes, status?, content_type?, body_base64?, auto_release_ms? }.
testSupportRouter.post("/test-support/hold-outbound", (req, res) => {
  const b = (req.body ?? {}) as {
    includes?: string;
    status?: number;
    content_type?: string;
    body_base64?: string;
    auto_release_ms?: number;
  };
  if (!b.includes || typeof b.includes !== "string" || b.includes.length < 4) {
    res.status(400).json({ error: { code: "bad_body", message: "includes (a URL substring, 4+ chars) required" } });
    return;
  }
  const canned = b.status !== undefined || b.content_type !== undefined || b.body_base64 !== undefined;
  const h = registerOutboundHold({
    includes: b.includes,
    ...(canned
      ? {
          respond: {
            ...(b.status !== undefined ? { status: b.status } : {}),
            ...(b.content_type !== undefined ? { contentType: b.content_type } : {}),
            ...(b.body_base64 !== undefined ? { body: new Uint8Array(Buffer.from(b.body_base64, "base64")) } : {}),
          },
        }
      : {}),
    ...(b.auto_release_ms !== undefined ? { autoReleaseMs: b.auto_release_ms } : {}),
  });
  res.status(201).json(h);
});

testSupportRouter.get("/test-support/hold-outbound/:id", (req, res) => {
  const st = outboundHoldStatus(String(req.params.id));
  if (!st) {
    res.status(404).json({ error: { code: "not_found", message: "no such hold" } });
    return;
  }
  res.json(st);
});

testSupportRouter.delete("/test-support/hold-outbound/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = req.query.forget === "1" ? forgetOutboundHold(id) : releaseOutboundHold(id);
  if (!ok) {
    res.status(404).json({ error: { code: "not_found", message: "no such hold" } });
    return;
  }
  res.json({ ok: true, ...(outboundHoldStatus(id) ?? { id, forgotten: true }) });
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

// The pools' counts with NO database round trip, so a test can watch a pool
// starve without joining the queue it is watching (#3033).
// The counts, and who holds each meta client that is checked out (which code
// took it, what it last ran, for how long): the CI sampler reads this the
// moment it sees a caller waiting, so a starved suite names its holder (#4876).
// What one probed request asked the meta database: the request sent
// `x-meta-probe: <id>`, this answers once it has finished (#4876).
testSupportRouter.get("/test-support/meta-probe/:id", (req, res) => {
  const p = readProbe(req.params.id!);
  if (!p) {
    res.status(404).json({ error: { code: "not_found", message: "no finished request carried that probe" } });
    return;
  }
  res.json(p);
});

// Make one workspace's short-lived caches cold, so a test measures what a read
// costs from cold every time instead of whatever warmth it happened to find
// (a cache that lapses mid-list is what made the bounded-meta test pass only on
// a retry, #4917). Only that workspace's entries: nobody else's test notices.
testSupportRouter.post("/test-support/forget-org-caches", (req, res) => {
  const orgId = typeof req.body?.org_id === "string" ? req.body.org_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) {
    res.status(400).json({ error: { code: "bad_request", message: "org_id is the workspace's id" } });
    return;
  }
  forgetOrgInTtlCaches(orgId);
  res.json({ ok: true });
});

testSupportRouter.get("/test-support/pool-stats", (_req, res) => {
  const meta = poolCounts(metaPool);
  res.json({ meta, tenants: tenantPoolStats(), meta_holders: meta.waiting > 0 ? poolHolders(metaPool).slice(0, 12) : [], meta_peak: poolPeak(metaPool) });
});


// An action whose handler THROWS, so a test can prove what the invoke route
// answers for a handler failure: `result.ok:false` with the handler's own
// sentence, never a bare 500 (#2847). The row is registered on demand and
// owned by the platform: no workspace can enable a "test-support" module, and
// the invoke door refuses an action whose module is off before its handler
// runs, so a module-owned stub would only ever test that refusal. The boot
// sync removes the row, since nothing declares it. Test-only, mounted under
// the same flag.
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
      module_name: PLATFORM_OWNER,
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
    .onConflict((b) => b.column("id").doUpdateSet({ invoke_handler: handlerKey, module_name: PLATFORM_OWNER }))
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

// An undo step whose run a test scripts (#7140), to prove when a failed Undo
// is still its requester's to press again: only a run that wrote nothing gives
// the step back. Each `key` counts its runs; `mode` says what run 1 does:
//   fail-first        crashes after a read, writes nothing
//   refuse-in-a-transaction  writes inside a transaction, refuses, rolls back
//   write-then-crash  commits a write, then crashes
//   slow              takes a moment, then applies
// Every later run applies. "Applies" is a committed write and a count.
// /test-support/issue-undo hands a person a step as a run of theirs would.
export const UNDO_STUB_ACTION_ID = "test-support:undo-stub";
const undoStubRuns = new Map<string, { runs: number; applied: number }>();
const touchWorkspace = (orgId: string, db: typeof meta = meta) => db.updateTable("orgs").set({ name: sql`name` }).where("id", "=", orgId).execute();
testSupportRouter.post("/test-support/undo-stub", async (_req, res, next) => {
  try {
    registerHandler("test-support.undo-stub", async (ctx) => {
      const { key, mode } = (ctx.args ?? {}) as { key?: string; mode?: string };
      const tally = undoStubRuns.get(String(key)) ?? { runs: 0, applied: 0 };
      undoStubRuns.set(String(key), tally);
      tally.runs++;
      if (tally.runs === 1) {
        if (mode === "fail-first") {
          await meta.selectFrom("orgs").select("id").where("id", "=", ctx.orgId).executeTakeFirst();
          throw new Error(CRASH_MESSAGE);
        }
        if (mode === "refuse-in-a-transaction") {
          await meta.transaction().execute(async (trx) => {
            await touchWorkspace(ctx.orgId, trx as unknown as typeof meta);
            throw new ActionRefusal(REFUSAL_SENTENCE);
          });
        }
        if (mode === "write-then-crash") {
          await touchWorkspace(ctx.orgId);
          throw new Error(CRASH_MESSAGE);
        }
        if (mode === "slow") await new Promise((r) => setTimeout(r, 400));
      }
      await touchWorkspace(ctx.orgId);
      tally.applied++;
      return { ok: true, applied: tally.applied };
    });
    await ensureStubAction(UNDO_STUB_ACTION_ID, "test-support.undo-stub", "Undo stub");
    res.json({ ok: true, action_id: UNDO_STUB_ACTION_ID });
  } catch (err) {
    next(err);
  }
});
testSupportRouter.get("/test-support/undo-stub/:key", (req, res) => {
  res.json(undoStubRuns.get(req.params.key) ?? { runs: 0, applied: 0 });
});
testSupportRouter.post("/test-support/issue-undo", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { org_id?: string; user_id?: string; action_id?: string; args?: Record<string, unknown>; entity_kind?: string; entity_id?: string };
    if (!b.org_id || !b.user_id || !b.action_id) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id, user_id and action_id required" } });
      return;
    }
    await issueUndos(b.org_id, b.user_id, [{ action_id: b.action_id, args: b.args ?? {}, entity_kind: b.entity_kind ?? null, entity_id: b.entity_id ?? null }]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// A placement row as it was stored before the kernel keyed every placement by
// the record's base kind (#3663): a collection's spelling, and a placed_at of
// the test's choosing, so the heal that folds them has something to fold and
// its "newest wins" can be put to the test. Test-only, mounted under the same
// flag. Body: { org_id, containee_kind, containee_id, container_kind,
// container_id, placed_at }.
testSupportRouter.post("/test-support/raw-placement", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (!b.org_id || !b.containee_kind || !b.containee_id || !b.container_kind || !b.container_id || !b.placed_at) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id, containee_kind/_id, container_kind/_id and placed_at required" } });
      return;
    }
    const db = await getTenantDb(b.org_id);
    await sql`insert into core_placement_placements (containee_kind, containee_id, container_kind, container_id, placed_at)
              values (${b.containee_kind}, ${b.containee_id}, ${b.container_kind}, ${b.container_id}, ${b.placed_at}::timestamptz)
              on conflict (containee_kind, containee_id) do update
                set container_kind = excluded.container_kind, container_id = excluded.container_id, placed_at = excluded.placed_at`.execute(db as never);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Every registered heal pass, by name, for the test that runs each one over
// rows made today and finds none changed (#7282).
testSupportRouter.get("/test-support/heal-passes", async (_req, res, next) => {
  try {
    const { registeredHealPasses } = await import("@cobblr/platform-contract/heal-pass");
    res.json({ names: registeredHealPasses() });
  } catch (err) {
    next(err);
  }
});

// A row as the old code left it: made before a heal's fix merged, so the heal
// takes it (a heal takes only rows made before its since, #7282). A test
// plants the old shape through the real doors, then dates it here. Test-only,
// mounted under the same flag. Body: { org_id, table, ids, at, column? }
// (column defaults to created_at).
testSupportRouter.post("/test-support/made-before", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { org_id?: string; table?: string; ids?: string[]; at?: string; column?: string };
    const ident = /^[a-z][a-z0-9_]*$/;
    const column = b.column ?? "created_at";
    if (!b.org_id || !b.table || !ident.test(b.table) || !ident.test(column) || !Array.isArray(b.ids) || !b.ids.length || !b.at) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id, table, ids and at required; column optional" } });
      return;
    }
    const db = await getTenantDb(b.org_id);
    const r = await sql`update ${sql.table(b.table)} set ${sql.ref(column)} = ${b.at}::timestamptz where id::text = any(${b.ids}::text[])`.execute(db as never);
    res.json({ ok: true, rows: Number(r.numAffectedRows ?? 0) });
  } catch (err) {
    next(err);
  }
});

// What a store's order page said, as an earlier read would have kept it, on
// the link waiting for an order number: CI cannot reach a store, so a test of
// "Read again from the page" stands in for the read. Body: { org_id,
// order_number, page_order }.
testSupportRouter.post("/test-support/order-page-was-read", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { org_id?: string; order_number?: string; page_order?: unknown };
    if (!b.org_id || !b.order_number || !b.page_order) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id, order_number and page_order required" } });
      return;
    }
    const db = await getTenantDb(b.org_id);
    const r = await sql`update purchases_order_pages set page_order = ${JSON.stringify(b.page_order)}::jsonb, last_outcome = 'read'
              where regexp_replace(coalesce(order_number, ''), '^#\\s*', '') = ${b.order_number.replace(/^#\s*/, "")}`.execute(db as never);
    res.json({ updated: Number(r.numAffectedRows ?? 0) });
  } catch (err) {
    next(err);
  }
});

// Notifications written together: `count` rows for one member, `per_ms` of
// them inside each millisecond at distinct microseconds, so a page boundary
// lands inside a millisecond, the case a cursor carried over JSON must
// survive. Test-only, mounted under the same flag. Body: { org_id, user_id,
// count, per_ms }.
// Run one person's notification retention prune now (it otherwise runs now
// and then as their notifications arrive).
testSupportRouter.post("/test-support/notifications/prune", async (req, res, next) => {
  try {
    const userId = (req.body ?? {}).user_id;
    if (typeof userId !== "string" || !userId) {
      res.status(400).json({ error: { code: "bad_body", message: "user_id required" } });
      return;
    }
    res.json({ pruned: await notifications.pruneRead(userId) });
  } catch (err) {
    next(err);
  }
});

testSupportRouter.post("/test-support/notifications", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { org_id?: string; user_id?: string; count?: number; per_ms?: number; read_days_ago?: number; message?: string };
    const count = Math.min(Math.max(Number(b.count) || 0, 1), 1000);
    const perMs = Math.min(Math.max(Number(b.per_ms) || 1, 1), 900);
    if (!b.org_id || !b.user_id) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id and user_id required" } });
      return;
    }
    // read_days_ago: seeded as read that long ago (the retention prune's input).
    const readDays = typeof b.read_days_ago === "number" && b.read_days_ago >= 0 ? b.read_days_ago : null;
    const prefix = typeof b.message === "string" && b.message ? b.message : "paged";
    await sql`insert into notifications (org_id, user_id, event_type, message, created_at, read_at)
              select ${b.org_id}::uuid, ${b.user_id}::uuid, 'test.paging', (${prefix} || ' ' || g),
                     (timestamptz '2026-01-01 00:00:00+00'
                       + ((g / ${perMs}) * interval '1 millisecond')
                       + ((g % ${perMs}) * interval '1 microsecond')),
                     case when ${readDays}::int is null then null else now() - make_interval(days => ${readDays}::int) end
              from generate_series(1, ${count}) as g`.execute(meta);
    res.json({ ok: true, count });
  } catch (err) {
    next(err);
  }
});

testSupportRouter.post("/test-support/exchange-rate-fixture", async (_req, res, next) => {
  try {
    await sql`insert into exchange_rates (rate_date, rates) values
      ('1998-12-23', '{"EUR":1,"NOK":12,"USD":1.12}'::jsonb),
      ('1998-12-24', '{"EUR":1,"NOK":10,"USD":1.2}'::jsonb)
      on conflict (rate_date) do update set rates = excluded.rates`.execute(meta);
    invalidateRateCache();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// A push service for CI (#5267): Web Push sends here when a test subscribed a
// "device" at this address, and the test reads back exactly what a browser
// would have been handed, to decrypt it with the device's own key. A box whose
// name starts with "gone-" answers 410, as a push service does for a
// subscription that no longer exists.
const pushBoxes = new Map<string, Array<{ body: string; headers: Record<string, string> }>>();
// The body is read as it came: a push is Content-Encoding aes128gcm, which a
// body parser would try to inflate and refuse; a push service keeps it sealed.
testSupportRouter.post("/test-support/push-service/:box", async (req, res) => {
  const box = String(req.params.box);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const list = pushBoxes.get(box) ?? [];
  list.push({
    body: Buffer.concat(chunks).toString("base64"),
    headers: Object.fromEntries(["authorization", "content-encoding", "ttl", "urgency"].map((h) => [h, String(req.get(h) ?? "")])),
  });
  pushBoxes.set(box, list);
  res.status(box.startsWith("gone-") ? 410 : 201).end();
});
testSupportRouter.get("/test-support/push-service/:box", (req, res) => {
  res.json({ items: pushBoxes.get(String(req.params.box)) ?? [] });
});

// One notification through the real dispatcher, with the priority and privacy
// a test chooses (#5267): every channel's routing, windows and quiet hours run
// as for any module's notification.
testSupportRouter.post("/test-support/dispatch", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as { org_id?: string; user_id?: string; message?: string; link_url?: string; priority?: string; private?: boolean; event_type?: string; subjects?: Array<{ kind: string; id: string; question: string; line?: string }> };
    if (!b.org_id || !b.user_id || !b.message) {
      res.status(400).json({ error: { code: "bad_body", message: "org_id, user_id and message required" } });
      return;
    }
    const priority = (["low", "normal", "high", "urgent"] as const).find((p) => p === b.priority) ?? "normal";
    const subjects = b.subjects?.length ? b.subjects : null;
    const common = {
      orgId: b.org_id,
      userId: b.user_id,
      eventType: b.event_type ?? "test.notification",
      message: b.message,
      priority,
      private: b.private === true,
    };
    const destination = b.link_url ? { link_url: b.link_url } : { no_link_reason: "a test notification" };
    // A producer that names what it is about is a calendar-raised notice.
    const out = subjects
      ? await notifications.dispatch({ ...common, ...destination, triggeredBy: "schedule", subjects: subjects.map((s) => ({ ...s, line: s.line ?? s.id })) })
      : await notifications.dispatch({ ...common, ...destination });
    res.json(out);
  } catch (err) {
    next(err);
  }
});
