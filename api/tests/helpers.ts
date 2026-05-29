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

export { registerOrgForTeardown };

const BASE = process.env.COBBLR_TEST_API ?? "http://localhost:4000";

export interface TestSession {
  token: string;
  userId: string;
  orgId: string;
  slug: string;
}

export async function signupFreshOrg(label: string): Promise<TestSession> {
  // Random suffix per signup so tests can run in parallel.
  const suffix = Math.random().toString(36).slice(2, 8);
  const body = {
    email: `${label}-${suffix}@cobblr-test.local`,
    password: "test-password-1234",
    display_name: label,
    org_name: `${label} ${suffix}`,
  };
  const res = await fetch(`${BASE}/api/v1/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  // Signup now enables ONLY the foundational substrate (blank-slate
  // onboarding — see enableFoundationalForOrg). Tests exercise module
  // functionality, not the empty-workspace default, so the harness
  // turns every module on — mirroring the pre-blank-slate behaviour the
  // suite was written against. (The blank-slate default itself is
  // covered by the driven walkthrough, not the unit suite.)
  await enableAllModulesForTests(session);
  return session;
}

/** Best-effort: enable every registered module that isn't already on
 *  for the test org. Single pass in list order; failures (e.g. a
 *  specialisation whose dep hasn't been reached yet) are ignored —
 *  the base modules every test relies on have no deps. Exported so
 *  tests that create SECONDARY workspaces (POST /orgs) — which signup
 *  no longer auto-enables under blank-slate onboarding — can turn their
 *  modules on too. */
export async function enableAllModulesForTests(session: {
  token: string;
  slug: string;
}): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/orgs/${session.slug}/modules`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) return;
  const { items } = (await res.json()) as {
    items: { name: string; enabled: boolean }[];
  };
  for (const m of items) {
    if (m.enabled) continue;
    await fetch(
      `${BASE}/api/v1/orgs/${session.slug}/modules/${m.name}/enable`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ).catch(() => {});
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
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  });
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
