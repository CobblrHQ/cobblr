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

import { sql, type Kysely } from "kysely";
import type { MetaDB } from "../db/schema.js";
import { lockKeyFor, withAdvisoryLock } from "./advisory-lock.js";

export { lockKeyFor, withAdvisoryLock } from "./advisory-lock.js";

/**
 * Run `work` only if no other api process is running the job of this name.
 *
 * Returns true when this process ran it, false when someone else held it. A
 * skipped tick is the normal, correct outcome — never an error.
 */
export async function runExclusive(name: string, work: () => Promise<void>): Promise<boolean> {
  // The meta handle is imported HERE, not at module load. Any file that adopts
  // this seam would otherwise gain an eager database import, and a unit test
  // that imports such a file in isolation dies on connection setup before it
  // reaches its subject — which is exactly what happened to
  // db-upgrade-status-quiet the moment this seam was added to that file.
  const { meta } = await import("../db/meta.js");
  const key = lockKeyFor(name);
  return withAdvisoryLock<Kysely<MetaDB>>({
    connect: (fn) => meta.connection().execute(fn),
    tryLock: async (conn) => {
      const got = await sql<{ locked: boolean }>`select pg_try_advisory_lock(${key}) as locked`.execute(conn);
      return got.rows[0]?.locked ?? false;
    },
    unlock: async (conn) => {
      await sql`select pg_advisory_unlock(${key})`.execute(conn);
    },
    work,
  });
}
