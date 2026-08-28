// The advisory-lock mechanic, with NOTHING that touches a database.
//
// Split from exclusive.ts on purpose: the interesting part (same connection for
// acquire and release; skip the work and never unlock when the lock was not
// taken) is a pure control-flow decision, and keeping it importable without the
// db module is what lets it be unit-tested with a fake connection.
//
// The reason it exists at all is in exclusive.ts.

import { createHash } from "node:crypto";

/** A stable 63-bit key for a name, so callers never hand-pick a magic int and
 *  two jobs can never silently collide on one. Postgres advisory keys are
 *  bigint; the top bit is cleared to keep it positive. */
export function lockKeyFor(name: string): bigint {
  const h = createHash("sha256").update(name).digest();
  return h.readBigUInt64BE(0) & 0x7fffffffffffffffn;
}

/** Acquire a session-scoped advisory lock, run `work`, release the lock —
 *  guaranteeing acquire and release land on the SAME backend connection.
 *
 *  A `pg_try_advisory_lock` is bound to the backend connection that ran it, but
 *  the meta handle is a POOL: Kysely checks out a fresh connection per
 *  statement, so acquiring and releasing as two separate calls can land on
 *  DIFFERENT connections. The release then no-ops ("you don't own a lock…") and
 *  the lock stays held until node-pg's idleTimeout reaps it — every intervening
 *  tick sees it held and skips (audit B4c). Pinning one connection for
 *  acquire+release closes that leak; `work` itself may use the pool freely.
 *
 *  Generic over the connection type so the mechanic (same conn for both, skip
 *  work and never unlock when not acquired) is unit-testable without a
 *  database. */
export async function withAdvisoryLock<C>(deps: {
  connect: <T>(fn: (conn: C) => Promise<T>) => Promise<T>;
  tryLock: (conn: C) => Promise<boolean>;
  unlock: (conn: C) => Promise<void>;
  work: () => Promise<void>;
}): Promise<boolean> {
  return deps.connect(async (conn) => {
    const locked = await deps.tryLock(conn);
    if (!locked) return false; // another holder — skip, and DO NOT release a lock we never took
    try {
      await deps.work();
    } finally {
      await deps.unlock(conn);
    }
    return true;
  });
}

