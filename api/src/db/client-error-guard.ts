import { Client, Pool } from "pg";
import type { ClientConfig, PoolConfig } from "pg";

/**
 * Every pg client this process opens listens for 'error' from the moment it
 * exists. This file is the only place a Pool or a Client is constructed.
 *
 * In Node an unhandled 'error' event does not log, it THROWS, and a throw out
 * of a socket read is an uncaught exception: the process exits. A Postgres
 * backend goes away under a client for ordinary reasons (a dropped database, a
 * terminated backend, a restart, a network blip), and pg reports it as an
 * 'error' event on the CLIENT whenever there is no query in flight to reject
 * into. So the whole api is one unlistened client away from exit 1.
 *
 * Three fixes attached the listener after the fact and each left a window:
 *
 *   - `pool.on("error")` hears IDLE clients only. pg-pool moves its listener
 *     off a client at checkout and back on at release (CI, 2026-08-25).
 *   - Guarding the client after `pool.connect()` resolved covered the checkout
 *     (2026-09-01), but a resolved promise is a microtask, and a FATAL that
 *     arrives in the same socket read as the connect handshake is emitted
 *     BEFORE that microtask runs: pg-pool has already removed its idle
 *     listener inside `_acquireClient`, the caller's guard is not on yet, and
 *     nobody is listening. That is how a workspace deletion, which terminates
 *     every backend of the tenant while the next request is opening a
 *     connection, took the api down (#2957).
 *   - Bare `new Client(...)` sites each remembered their own `.on("error")`,
 *     one at a time, with a lint counting lines.
 *
 * The only window-free seam is construction. `createPool` hands pg-pool a
 * Client class whose constructor attaches the listener, so a pool client is
 * listening before its socket opens and stays listening through checkout,
 * release, idle and end; pg-pool's own add/remove of its idle listener happens
 * on top and changes nothing. `createClient` does the same for a bare client.
 * `lint:pg-clients-born-guarded` refuses `new Pool(` / `new Client(` anywhere
 * else, so the next connection somebody opens cannot miss it.
 *
 * The listener logs and continues. The next query on that client rejects
 * through the caller's ordinary error path, which is where the decision
 * belongs; pg-pool drops a client that errored instead of re-idling it.
 */

type ClientClass = new (config?: ClientConfig) => Client;

function onClientError(label: string): (err: Error) => void {
  return (err) => {
    console.error(`[${label}] connection error:`, err.message);
  };
}

/** A Client class whose every instance is listening before `connect()`. The
 *  base is pg's Client, or whatever the pool config names (a test's fake). */
function bornGuarded(label: string, Base: ClientClass): ClientClass {
  return class GuardedClient extends Base {
    constructor(config?: ClientConfig) {
      super(config);
      this.on("error", onClientError(label));
    }
  };
}

/** The one way to open a pool. `label` names it in the log line. */
export function createPool(config: PoolConfig, label: string): Pool {
  const Base = (config.Client as ClientClass | undefined) ?? Client;
  const pool = new Pool({ ...config, Client: bornGuarded(label, Base) });
  // pg-pool re-emits an idle client's error on the pool and, being an
  // EventEmitter, throws if nobody listens there either. The client's own
  // listener already logged it; this one only keeps the pool's emit harmless.
  pool.on("error", () => {});
  return pool;
}

/** The one way to open a bare client (superuser work, a maintenance DB). */
export function createClient(config: ClientConfig | string, label: string): Client {
  const client = new Client(config);
  client.on("error", onClientError(label));
  return client;
}
