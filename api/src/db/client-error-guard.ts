import type { Pool, PoolClient } from "pg";

/**
 * Keep a CHECKED-OUT client's 'error' event from killing the process.
 *
 * `pool.on("error", …)` is not enough, and the reason is one line of pg-pool:
 * `_acquireClient` calls `client.removeListener('error', idleListener)`. The pool
 * listens to IDLE clients only. From the moment `pool.connect()` hands a client
 * over until `release()`, that client has no listener at all, and in Node an
 * unhandled 'error' event does not log, it THROWS. So a backend that dies while
 * a client is borrowed takes down the whole api.
 *
 * That window is not rare, it is exactly where the slow work happens: a loop
 * holding the client across `await readFile` gaps, a migration on a freshly
 * created tenant database, a backfill, and every Kysely transaction, which holds
 * a client between its statements. If a parallel test fork's teardown DROPs that
 * database mid-run, Postgres sends 57P01 (admin_shutdown) and there is no
 * in-flight query to reject into. The api died once and every request after it
 * failed, which reads as dozens of unrelated tests breaking rather than as one
 * missing listener (CI 2026-08-31 and again 2026-09-01).
 *
 * Returns a detach function. Call it in the same `finally` that releases, so a
 * long-lived pooled connection does not accumulate a listener per checkout.
 */
export function guardClient(client: PoolClient, label: string): () => void {
  const onError = (err: Error) => {
    // Log and continue. The next query on this client rejects through the
    // caller's ordinary error path, which is where the decision belongs.
    console.error(`[${label}] connection error while checked out:`, err.message);
  };
  client.on("error", onError);
  return () => {
    client.removeListener("error", onError);
  };
}

/**
 * Guard EVERY client a pool hands out, at the one seam they all pass through.
 *
 * Guarding call sites one at a time cannot finish the job: Kysely acquires its
 * own clients (`PostgresDriver` calls `pool.connect()` and holds the client for
 * the length of a transaction), so the most common checkout in the codebase is
 * one no application file ever writes. Wrapping `connect` here covers Kysely,
 * every hand-written `pool.connect()`, and whatever is written next, with
 * nothing for a caller to remember.
 *
 * Each client is guarded on the way out and unguarded on `release()`, so a
 * pooled connection carries one listener while borrowed and none while idle,
 * where pg-pool's own listener takes over again. Both of pg's `connect` shapes
 * are handled; the callback form is given the guarded `release` as its `done`,
 * so releasing through either name detaches.
 *
 *   const pool = new Pool({ … });
 *   pool.on("error", …);           // idle clients — pg-pool's contract
 *   guardPoolClients(pool, "meta"); // checked-out clients — this one
 */
export function guardPoolClients(pool: Pool, label: string): void {
  type Done = (release?: Error | boolean) => void;
  type Callback = (err: Error | undefined, client?: PoolClient, done?: Done) => void;
  const connect = (pool.connect as (...args: unknown[]) => unknown).bind(pool);

  const guarded = function guardedConnect(this: Pool, ...args: unknown[]): unknown {
    if (typeof args[0] === "function") {
      const cb = args[0] as Callback;
      return connect((err: Error | undefined, client?: PoolClient, done?: Done) => {
        if (client) {
          attach(client, label);
          cb(err, client, client.release as Done);
          return;
        }
        cb(err, client, done);
      });
    }
    return (connect() as Promise<PoolClient>).then((client) => {
      attach(client, label);
      return client;
    });
  };

  (pool as unknown as { connect: unknown }).connect = guarded;
}

function attach(client: PoolClient, label: string): void {
  const detach = guardClient(client, label);
  // pg-pool assigns a fresh once-only `release` on every checkout, so restoring
  // the original after use keeps that contract exactly as it was.
  const release = client.release;
  client.release = function guardedRelease(this: PoolClient, err?: Error | boolean) {
    detach();
    client.release = release;
    return release.call(this, err);
  } as PoolClient["release"];
}
