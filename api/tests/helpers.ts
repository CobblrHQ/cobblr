// Thin HTTP client for integration tests. Tests run against a live
// API on COBBLR_TEST_API (defaults to http://localhost:4000) with a
// real Postgres backing it. Each suite creates a fresh org so runs
// are idempotent and isolated from one another.

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
  return {
    token: json.token,
    userId: json.user.id,
    orgId: json.orgs[0]!.id,
    slug: json.orgs[0]!.slug,
  };
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
