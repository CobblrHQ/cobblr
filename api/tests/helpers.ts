// Thin HTTP client for integration tests. Tests run against a live
// API on COBBLR_TEST_API (defaults to http://localhost:4000) with a
// real Postgres backing it. Each suite creates a fresh org so runs
// are idempotent and isolated from one another.
//
// Teardown: every org created by `signupFreshOrg` or
// `registerOrgForTeardown` is deleted at end-of-file by the
// afterAll hook in setup-teardown.ts (wired via vitest.config.ts's
// setupFiles). Tests that POST /orgs ad-hoc must register the new
// session themselves; helper exported here for that case.

import { registerOrgForTeardown } from "./setup-teardown.js";
import { fetchTransient } from "./fetch-transient.js";
import { noteProvisioning, type ProvisionedBy } from "./fixture-log.js";
import { eventually } from "./eventually.js";
import { arrivedEverywhere, dayIn } from "@cobblr/platform-contract/day";

export { registerOrgForTeardown };

export const BASE = process.env.COBBLR_TEST_API ?? "http://localhost:4000";

/** Host the API uses to call back to a test-spawned receiver (webhooks /
 *  notification channels). Dev: the api runs in Docker, so it reaches the
 *  host (where the test's receiver listens) via host.docker.internal. CI:
 *  the api runs on the runner via tsx, next to the test → 127.0.0.1.
 *  Override with COBBLR_TEST_CALLBACK_HOST. The api must also have
 *  COBBLR_WEBHOOK_ALLOW_INTERNAL=1 for its SSRF guard to permit it. */
export const TEST_CALLBACK_HOST =
  process.env.COBBLR_TEST_CALLBACK_HOST ?? "host.docker.internal";

export interface TestSession {
  token: string;
  userId: string;
  orgId: string;
  slug: string;
}

/** Signup is the suite's single point of failure: EVERY test file calls it, and
 *  it's the heaviest request in the suite — it CREATE DATABASEs a fresh tenant
 *  (a Postgres template lock that serialises across all concurrent signups),
 *  runs every module migration, and seeds bindings. Under 8-fork CI contention
 *  against one shared API container, a signup can transiently 5xx/429 or time
 *  out while pools warm. A bare throw here leaves the file's shared session
 *  state undefined and cascades into every sibling test — vitest's per-test
 *  `retry` can't help, because the failure is in a setup step many other tests
 *  already consumed. So absorb the transient AT THE SOURCE: retry on a network
 *  error or a retryable status (5xx/429), with backoff. A real signup bug
 *  (4xx, bad body) still throws on the first attempt — we only retry transients. */
async function signupOnce(body: unknown): Promise<Response> {
  // Retries transients (network error + 5xx/429) so a signup blip under 8-fork
  // load doesn't cascade; a 400/409 (real failure) returns on the first attempt.
  return fetchTransient(`${BASE}/api/v1/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Pool fast path: check out a pre-provisioned org instead of provisioning one.
 *  Returns null when the pool is off, empty, or the request fails — the caller
 *  then falls back to a real signup, so the pool is a pure optimization. */
/** A pooled workspace, or why there was none (fixture-log.ts keeps the reason for the measurement ledger). */
async function tryCheckoutPoolOrg(): Promise<{ session: TestSession | null; by: ProvisionedBy }> {
  if (!process.env.COBBLR_TEST_ORG_POOL) return { session: null, by: "pool off" };
  try {
    // Retry the CHEAP checkout on a transient blip. Falling back to a full
    // signup (CREATE DATABASE) on every blip would ADD to the storm that caused
    // the blip. A real 409 (pool_exhausted) still returns immediately → signup.
    const res = await fetchTransient(`${BASE}/api/v1/test-support/checkout-org`, { method: "POST" });
    if (!res.ok) return { session: null, by: res.status === 409 ? "pool exhausted" : `pool HTTP ${res.status}` }; // → real signup
    const j = (await res.json()) as { token: string; userId: string; orgId: string; slug: string };
    return { session: { token: j.token, userId: j.userId, orgId: j.orgId, slug: j.slug }, by: "pool" };
  } catch {
    return { session: null, by: "pool unreachable" };
  }
}

/** The worst case of one fresh workspace, and so the floor for any test that
 *  signs up inside its own body: the pool checkout is instant, but the pool
 *  runs out on a full suite and the fallback is a CREATE DATABASE behind a
 *  template lock that serialises every concurrent signup (5 to 15 s on a
 *  loaded runner) followed by enabling every module in waves (another 20 to
 *  30 s under DDL contention). The suite's global testTimeout is this same
 *  number for that reason. A per-test budget BELOW it timed
 *  attention.test.ts out twice on one tree and blocked a deploy (#2867);
 *  lint:test-budget-covers-signup refuses a smaller one. */
export const FRESH_ORG_BUDGET_MS = 60_000;

/** A workspace for one test. It is NOT the workspace a person gets at
 *  signup: the pooled one and the fallback both arrive with EVERY module on.
 *  A test about a module that is off turns it off itself
 *  (`POST /modules/<name>/disable`); two such tests passed locally and failed
 *  in CI by assuming a fresh workspace had one off (2026-09-28). */
export async function signupFreshOrg(label: string): Promise<TestSession> {
  const started = performance.now();
  // Pool fast path — a checked-out org is already all-modules-provisioned.
  const { session: pooled, by } = await tryCheckoutPoolOrg();
  if (pooled) {
    registerOrgForTeardown({ token: pooled.token, slug: pooled.slug });
    // Cheap top-up: no-op when the pooled org already has every module (the
    // common case); self-heals a pool baked before a new module was added.
    await enableAllModulesForTests(pooled);
    noteProvisioning(by, performance.now() - started);
    return pooled;
  }
  const session = await signupBlankOrg(label);
  // Signup now enables ONLY the foundational substrate (blank-slate
  // onboarding — see enableFoundationalForOrg). Tests exercise module
  // functionality, not the empty-workspace default, so the harness
  // turns every module on — mirroring the pre-blank-slate behaviour the
  // suite was written against. (The blank-slate default itself is
  // covered by the driven walkthrough, not the unit suite.)
  await enableAllModulesForTests(session);
  noteProvisioning(by, performance.now() - started);
  return session;
}

/** A workspace exactly as signup leaves it: the foundational substrate and
 *  NOTHING else on. For the few tests whose subject is the blank slate itself
 *  (what a step does before any domain module exists), since signupFreshOrg
 *  turns every module on. Never pooled (a pooled org is fully provisioned);
 *  same retries and teardown as the helper above. */
export async function signupBlankOrg(label: string): Promise<TestSession> {
  // Random suffix per signup so tests can run in parallel.
  const suffix = Math.random().toString(36).slice(2, 8);
  const body = {
    email: `${label}-${suffix}@cobblr-test.local`,
    password: "test-password-1234",
    display_name: label,
    org_name: `${label} ${suffix}`,
  };
  const res = await signupOnce(body);
  if (!res.ok) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    token: string;
    user: { id: string };
    orgs: { id: string; slug: string }[];
  };
  const session: TestSession = {
    token: json.token,
    userId: json.user.id,
    orgId: json.orgs[0]!.id,
    slug: json.orgs[0]!.slug,
  };
  // Register for teardown — afterAll() in setup-teardown.ts deletes
  // every registered workspace at end-of-file. Without this the
  // dev/CI DB accumulates orphan tenant DBs forever.
  registerOrgForTeardown({ token: session.token, slug: session.slug });
  return session;
}

/** Enable every registered module that isn't already on for the test org,
 *  EXCEPT the ones a workspace is born with (`born_with`: foundational or
 *  autoEnable). Those must already be on from signup itself; switching them
 *  on here hid a module the kernel never enabled at signup (core-presentation
 *  sat in 8 of 119 workspaces, all of them made by this helper), so a missing
 *  one now fails the test that needs it, as it fails a real person.
 *  Exported so tests that create SECONDARY workspaces (POST /orgs) — which
 *  signup no longer auto-enables under blank-slate onboarding — can turn
 *  their modules on too.
 *
 *  This is the suite's dominant cost: it used to fire ~29 `/enable` calls
 *  STRICTLY SEQUENTIALLY per org, and provisioning is ~63% of CI runtime
 *  (profiled 2026-07-05: 174 orgs × 5.55s). Now it enables in capped-
 *  concurrency WAVES: fire a batch, keep the ones that failed (usually an
 *  unmet dependency — "enable X first" — or transient Postgres catalog
 *  contention from concurrent DDL on one tenant DB), and retry them next
 *  wave once their dep is on / the contention clears. Converges to the same
 *  full enable-able set as the old single pass, just overlapped. The cap
 *  (5, matching the api's per-tenant pool) keeps concurrent DDL bounded, and
 *  the retry naturally absorbs the occasional contention failure. */
export async function enableAllModulesForTests(session: {
  token: string;
  slug: string;
}): Promise<void> {
  const res = await fetchTransient(`${BASE}/api/v1/orgs/${session.slug}/modules`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) return;
  const { items } = (await res.json()) as {
    items: { name: string; enabled: boolean; born_with?: boolean }[];
  };
  let remaining = items.filter((m) => !m.enabled && !m.born_with).map((m) => m.name);
  if (remaining.length === 0) return;

  const enableOne = async (name: string): Promise<boolean> => {
    try {
      const r = await fetchTransient(`${BASE}/api/v1/orgs/${session.slug}/modules/${name}/enable`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      return r.ok; // non-2xx (e.g. unmet dep) → retry in the next wave
    } catch {
      return false;
    }
  };

  const CAP = 5;
  const MAX_WAVES = 10; // dep chains are ≤2 deep; extra waves only absorb retries
  for (let wave = 0; wave < MAX_WAVES && remaining.length > 0; wave++) {
    const failed: string[] = [];
    let idx = 0;
    const batch = remaining;
    await Promise.all(
      Array.from({ length: Math.min(CAP, batch.length) }, async () => {
        while (idx < batch.length) {
          const name = batch[idx++]!;
          if (!(await enableOne(name))) failed.push(name);
        }
      }),
    );
    if (failed.length === batch.length) break; // no progress → genuinely un-enable-able; stop (old code ignored these too)
    remaining = failed;
  }
}

export async function http<T = unknown>(
  session: TestSession,
  path: string,
  init?: { method?: string; body?: unknown; expectStatus?: number },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.token}`,
  };
  let body: string | undefined;
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  // Network-only retry: absorbs a transient "fetch failed" when http() is used
  // in a beforeAll/afterAll (which vitest's per-test retry never re-runs), but
  // does NOT retry 5xx — a test may legitimately assert one via expectStatus.
  // The api's own "busy" is asked again unless the test expects that 503.
  const res = await fetchTransient(
    `${BASE}${path}`,
    { method: init?.method ?? "GET", headers, body },
    { retryServerErrors: false, retryBusy: init?.expectStatus !== 503 },
  );
  if (init?.expectStatus !== undefined) {
    if (res.status !== init.expectStatus) {
      throw new Error(
        `expected ${init.expectStatus}, got ${res.status}: ${await res.text()}`,
      );
    }
  } else if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${await res.text()}`);
  }
  if (res.status === 204) return undefined as T;
  // Some POSTs return 201 with no body. Detect via content-length.
  const cl = res.headers.get("content-length");
  if (cl === "0") return undefined as T;
  return (await res.json()) as T;
}

export function org(session: TestSession, path: string): string {
  return `/api/v1/orgs/${session.slug}${path}`;
}

export async function isApiUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/v1/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

// The wasm sandbox's read-bearing kernel ops (TENANT_QUERY / CATALOGS /
// PAIRINGS / ACTIVITY_LOG read-backs) round-trip a response through a
// SharedArrayBuffer + Atomics.wait/notify between the host thread and the
// worker. That mechanism returns undefined responses ONLY inside the Forgejo
// CI runner's job container — it passes on dev machines AND inside the prod
// docker image (node:22-alpine), which is what actually ships. Rather than
// let a runner-container quirk wedge every deploy (the test job now gates
// deploys), CI sets COBBLR_CI_SKIP_SANDBOX_READOPS=1 to skip just these and
// stays green. FOLLOW-UP (docs/BACKLOG.md): run the sandbox suite inside the
// built prod image in CI to restore this coverage in the env that works.
export const SKIP_SANDBOX_READOPS_IN_CI =
  process.env.COBBLR_CI_SKIP_SANDBOX_READOPS === "1";

/** The result of an action, unwrapped.
 *
 *  POST /actions/invoke answers `{ ok: true, result: <what the handler
 *  returned> }` where the OUTER ok only means "dispatched". A handler that
 *  refuses returns `{ ok: false, error }` INSIDE result, so `expect(res.ok).toBe(false)`
 *  on the envelope is a test that can never fail — three of them passed locally
 *  and were caught by CI only because the happy-path assertions failed alongside.
 *  Every test that invokes an action goes through here, so nobody unwraps it by
 *  hand again. */
export interface ActionOutcome {
  ok: boolean;
  summary?: string;
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export async function invokeAction(
  session: TestSession,
  actionId: string,
  args: Record<string, unknown>,
  entity?: { kind: string; id: string },
): Promise<ActionOutcome> {
  try {
    const res = await http<{ ok: boolean; result: ActionOutcome }>(session, org(session, "/actions/invoke"), {
      method: "POST",
      body: {
        actionId,
        args,
        ...(entity ? { entityKind: entity.kind, entityId: entity.id } : {}),
      },
    });
    return res.result ?? { ok: false, error: "the invoke returned no result" };
  } catch (err) {
    // A refusal the route turned into a status code is still a refusal.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A calendar day, `daysFromToday` from the day the platform takes as TODAY
 *  for a person who never told it their timezone (a fresh test signup): the
 *  day that has arrived everywhere (@cobblr/platform-contract/day, #3351).
 *
 *  Never the UTC day of the live clock. Between 00:00 and 12:00 UTC the two
 *  differ, so a test comparing the product's date with the UTC one goes red
 *  for half of every day; main went red that way at 00:14 UTC on 2026-09-23
 *  in three expiry tests. lint:one-day-rule refuses the UTC form, api/tests
 *  included. */
export function personDay(daysFromToday = 0, now: Date = new Date()): string {
  const base = arrivedEverywhere(now);
  return new Date(Date.parse(`${base}T00:00:00Z`) + daysFromToday * 86_400_000).toISOString().slice(0, 10);
}

/** A zone whose calendar date is NOT the UTC date at `now`, and whose own date
 *  does not turn over for at least two hours (so a test and the product, both
 *  reading this zone, agree for the whole run).
 *
 *  A test that compares the product's day with the UTC day only catches a
 *  product path that dates things in UTC when the two dates differ, which with
 *  no zone stated is 00:00 to 12:00 UTC: half the runs were blind, and the
 *  ones that were not failed "every evening" instead of at review. A person in
 *  a zone that is on another date right now makes that state universal: the
 *  bug fails every run, whatever the hour (run 25414, #3513).
 *
 *  Before 10:00 UTC, UTC-12 is still on yesterday (it turns over at 12:00);
 *  from 10:00, UTC+14 is already on tomorrow (it turns over at 10:00 next
 *  day). Across UTC midnight no zone stays on another date, so a run that
 *  straddles it loses the detection for its last minutes, never the
 *  agreement. */
export function zoneOnAnotherDay(now: Date = new Date()): string {
  return now.getUTCHours() < 10 ? "Etc/GMT+12" : "Pacific/Kiritimati";
}

/** Tell the platform this person's zone, the way a person does (their delivery
 *  preferences), so every "today" the product works out for them is that
 *  zone's. Returns the zone, after checking it really is on another day than
 *  UTC: a test built on a zone that happens to agree with UTC proves nothing. */
export async function livesOnAnotherDay(s: TestSession, now: Date = new Date()): Promise<string> {
  const zone = zoneOnAnotherDay(now);
  const utcDay = now.toISOString().slice(0, 10); // UTC-DAY OK: the frame this test must differ from
  if (dayIn(now, zone) === utcDay) throw new Error(`${zone} is on the UTC day ${utcDay}; the test would be blind`);
  await http(s, "/api/v1/me/delivery-windows", { method: "PUT", body: { channel: "in_app", mode: "immediate", timezone: zone } });
  return zone;
}

/** A calendar day `daysFromToday` from today in `zone`: the day the product
 *  takes as today for a person who said they live there. */
export function dayInZone(zone: string, daysFromToday = 0, now: Date = new Date()): string {
  return new Date(Date.parse(`${dayIn(now, zone)}T00:00:00Z`) + daysFromToday * 86_400_000).toISOString().slice(0, 10);
}

/** The fixed platform admin CI configures in SUPERADMIN_EMAILS, signed in
 *  (made on first use): the one account a /super-admin test can act as.
 *  Null when this api does not treat it as a platform admin. */
export const PLATFORM_ADMIN_EMAIL = "cobblr-test-platform-admin@cobblr-test.local";
const PLATFORM_ADMIN_PASSWORD = "cobblr-test-admin-fixed-pwd-1234";
export async function platformAdminSession(): Promise<{ token: string; userId: string } | null> {
  const post = (path: string, body: unknown) =>
    fetch(`${BASE}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const attempts = [
    () => post("/auth/login", { email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
    // shared-name: the one platform admin CI lists in SUPERADMIN_EMAILS; made once, signed into after.
    () => post("/auth/signup", { email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD, display_name: "cobblr test admin", org_name: "cobblr-test-admin" }),
    () => post("/auth/login", { email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD }),
  ];
  for (const attempt of attempts) {
    const r = await attempt();
    if (!r?.ok) continue;
    const j = (await r.json()) as { token: string; user: { id: string } };
    const health = await fetch(`${BASE}/api/v1/super-admin/health`, { headers: { Authorization: `Bearer ${j.token}` } });
    return health.ok ? { token: j.token, userId: j.user.id } : null;
  }
  return null;
}

/** A name of this run's own, for something unique across the whole instance
 *  (a workspace, an account): CI runs every file against one database, so a
 *  fixed name depends on whether another file made it first (#4892,
 *  lint:tests-own-their-names). "Second workspace" → "Second workspace k3x9q2". */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}

/** Turn a module on (or off) for a workspace, and come back only once the
 *  workspace says it is. A setup that swallowed its enable let a test start
 *  before the module was on, then pass on a retry once it was (#4922);
 *  lint:setup-states-what-it-sets holds api tests to this. */
export async function ensureModule(s: { token: string; slug: string }, name: string, on = true): Promise<void> {
  const res = await fetchTransient(`${BASE}/api/v1/orgs/${s.slug}/modules/${name}/${on ? "enable" : "disable"}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const said = `${res.status} ${(await res.text()).slice(0, 200)}`;
  const isOn = async (): Promise<boolean> => {
    const r = await fetchTransient(`${BASE}/api/v1/orgs/${s.slug}/modules`, { headers: { Authorization: `Bearer ${s.token}` } });
    const j = (await r.json()) as { items: Array<{ name: string; enabled: boolean }> };
    return j.items.find((m) => m.name === name)?.enabled ?? false;
  };
  // A request retried over a dropped connection may still be finishing the
  // first one: the workspace's own word decides, within a deadline.
  if ((await eventually(isOn, (v) => v === on, 30_000)) !== on) {
    throw new Error(`${name} did not turn ${on ? "on" : "off"} in ${s.slug}: the ${on ? "enable" : "disable"} answered ${said}`);
  }
}

export { mapLimit } from "./map-limit.js";
