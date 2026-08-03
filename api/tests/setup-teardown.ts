// Global test teardown — guarantees every workspace owned by a
// test user is deleted at the end of that test file, even if a
// test threw mid-flight. Without this, every test run leaks tenant
// DBs; over hundreds of runs the dev box accumulates thousands of
// orphan databases that exhaust Postgres connection slots and disk.
//
// Strategy: we track bearer tokens (one per signupFreshOrg call),
// and at teardown each token is used to list /me's orgs and DELETE
// each one the user owns. This covers not just the first org made
// at signup but any extras created by `POST /orgs` ad-hoc — those
// belong to the same user, so the same token reaches them.
//
// Wired via vitest.config.ts `setupFiles`. afterAll here is scoped
// to the file vitest is currently running, so the registry resets
// cleanly between files.

import { afterAll } from "vitest";
import { fetchTransient } from "./fetch-transient.js";

const BASE = process.env.COBBLR_TEST_API ?? "http://localhost:4000";

const tokens = new Set<string>();

export function registerOrgForTeardown(o: { token: string; slug?: string }): void {
  tokens.add(o.token);
}

interface MeResponse {
  orgs: Array<{ id: string; slug: string; role: string }>;
}

afterAll(async () => {
  if (tokens.size === 0) return;
  const items = Array.from(tokens);
  tokens.clear();

  // Discover every owner-role org under each registered token.
  const targets: Array<{ token: string; slug: string }> = [];
  for (const token of items) {
    try {
      const res = await fetchTransient(`${BASE}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const me = (await res.json()) as MeResponse;
      for (const org of me.orgs) {
        if (org.role === "owner") {
          targets.push({ token, slug: org.slug });
        }
      }
    } catch (err) {
      console.warn(
        "[test-teardown] /me failed:",
        (err as Error).message,
      );
    }
  }
  if (targets.length === 0) return;

  // Cap concurrency — DROP DATABASE is expensive and runs under the
  // meta pool. 8 at a time matches migrate-sync's sweet spot.
  const CONCURRENCY = 8;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++]!;
      try {
        // Retry a transient DELETE blip so the DROP-DATABASE teardown storm
        // doesn't leak orphan tenant DBs (which pile up and eventually exhaust
        // Postgres connection slots — the very thing that causes the storm).
        const res = await fetchTransient(`${BASE}/api/v1/orgs/${item.slug}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${item.token}` },
        });
        if (!res.ok && res.status !== 404) {
          console.warn(
            `[test-teardown] DELETE /orgs/${item.slug} → ${res.status}`,
          );
        }
      } catch (err) {
        console.warn(
          `[test-teardown] DELETE /orgs/${item.slug} threw:`,
          (err as Error).message,
        );
      }
    }
  });
  await Promise.all(workers);
});
