// One owner per named job, across every api process sharing this database.
//
// THE PROBLEM THIS EXISTS FOR. A periodic loop is started by every api process
// (a module's lifecycle.onBoot, a kernel sweeper). For most of this platform's
// life that meant one process, so "started at boot" and "runs once" were the
// same sentence. They are not the same sentence any more: the canary channel
// runs a SECOND api against the very same Postgres (design-decisions/
// canary-channel.md), and a rolling deploy briefly runs two as well. Every
// side-effecting loop then does its work twice on real user data.
//
// It was found in the mildest possible way, which is the only luck in it: a
// workspace's printer posted its progress to Discord twice, every time, for
// weeks (2026-08-29). The same doubling was running through every unguarded
// sweeper in the tree.
//
// The mechanic is the one delivery-sweeper.ts already proved (audit B4c) and
// is lifted here so nobody has to re-derive it: a session-scoped
// pg_try_advisory_lock, acquired and released on ONE pinned connection.
//
// WHAT THIS DOES AND DOES NOT PROMISE. It guarantees the work does not run
// CONCURRENTLY in two processes. It does not by itself guarantee the work
// happens once: the loser skips this tick, but its next tick may find the job
// free and do it again. So the work must be idempotent, or must claim what it
// is about to act on (delete the bucket, compare-and-set the row) INSIDE the
// lock. Where a claim is available, the claim is the real guard and this is
// contention control on top of it.

import type { Client } from "pg";
import { lockKeyFor, withAdvisoryLock } from "./advisory-lock.js";

export { lockKeyFor, withAdvisoryLock } from "./advisory-lock.js";

/**
 * Run `work` only if no other api process is running the job of this name.
 *
 * Returns true when this process ran it, false when someone else held it. A
 * skipped tick is the normal, correct outcome — never an error.
 *
 * The lock lives on a connection of its OWN, opened for the tick and closed
 * after it, never a client borrowed from the meta pool. A session lock has to
 * stay on one connection for as long as the work runs, and the work of a
 * sweep is minutes of fetches and tenant rounds; borrowed from the pool, that
 * was one request's worth of capacity spent for the whole sweep, and a sweep
 * that hung spent it forever. Six such jobs and a pool of ten is how the api
 * hung on the dev rig with nothing in the log (#3033). The work itself uses
 * the pool through `meta` like any request, and gives each client back per
 * statement.
 */
export async function runExclusive(name: string, work: () => Promise<void>): Promise<boolean> {
  // The db modules are imported HERE, not at module load. Any file that adopts
  // this seam would otherwise gain an eager database import, and a unit test
  // that imports such a file in isolation dies on connection setup before it
  // reaches its subject — which is exactly what happened to
  // db-upgrade-status-quiet the moment this seam was added to that file.
  const { env } = await import("../env.js");
  const { createClient } = await import("../db/client-error-guard.js");
  const key = lockKeyFor(name);
  return withAdvisoryLock<Client>({
    connect: async (fn) => {
      const client = createClient({ connectionString: env.DATABASE_URL }, `advisory-lock ${name}`);
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end().catch(() => {});
      }
    },
    tryLock: async (conn) => {
      const got = await conn.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [key.toString()]);
      return got.rows[0]?.locked ?? false;
    },
    unlock: async (conn) => {
      await conn.query("select pg_advisory_unlock($1)", [key.toString()]);
    },
    work,
  });
}
