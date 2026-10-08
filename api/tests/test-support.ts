// The one way an api test reaches the test-support doors (/api/v1/test-support,
// api/src/routes/test-support.ts).
//
// Those doors are mounted only when the api runs with COBBLR_TEST_ORG_POOL.
// Thirty-three test files called them with a bare fetch and read nothing back,
// so an api started without it (a throwaway api on a dev machine) answered
// every setup step 404 and the test then failed on its own assertion: "expected
// [] to have a length of 1", read as a product bug and reported as one (an
// arrival heal was blamed on date rot that did not exist, 2026-10-06). Here a
// door that is not there says so, naming the fix, and a door that refuses says
// what it answered, before the test asserts anything.
// lint:test-support-through-the-helper keeps every test on it.

import { BASE } from "./helpers.js";

export interface TestSupportInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  /** Statuses the caller reads itself (a test of a refusal). Anything else
   *  outside 2xx throws. */
  allow?: number[];
}

let mounted: boolean | null = null;

/** Whether this api opens the test-support doors at all: for a helper that
 *  skips, never passes, without them. */
export async function testSupportMounted(): Promise<boolean> {
  if (mounted !== null) return mounted;
  try {
    mounted = (await fetch(`${BASE}/api/v1/test-support/pool-status`)).status !== 404;
  } catch {
    mounted = false;
  }
  return mounted;
}

/** Call a test-support door: `path` is what follows `/test-support/`. Returns
 *  the Response; throws on a status the caller did not allow, and says plainly
 *  when the doors are not mounted at all. */
export async function testSupport(path: string, init: TestSupportInit = {}): Promise<Response> {
  const url = `${BASE}/api/v1/test-support/${path.replace(/^\/+/, "")}`;
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const res = await fetch(url, {
    method,
    ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  if (res.ok || init.allow?.includes(res.status)) return res;
  if (!(await testSupportMounted())) {
    throw new Error(
      `test-support is not mounted on ${BASE}: start the api with COBBLR_TEST_ORG_POOL=1. ` +
        `${method} /test-support/${path} answered ${res.status}, so this test never reached what it checks.`,
    );
  }
  const text = await res.text().catch(() => "");
  throw new Error(`${method} /test-support/${path} answered ${res.status}: ${text.slice(0, 300)}`);
}

/** The same, read as JSON. */
export async function testSupportJson<T = unknown>(path: string, init: TestSupportInit = {}): Promise<T> {
  return (await (await testSupport(path, init)).json()) as T;
}

/** The address of the CI push service's box `box` (#5267): what a test
 *  "device" subscribes with, so Web Push sends there and the test reads it
 *  back through testSupport(`push-service/${box}`). */
export function testPushServiceEndpoint(box: string): string {
  return `${BASE}/api/v1/test-support/push-service/${encodeURIComponent(box)}`;
}
