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
 *
 * Every pool also carries a connect timeout. pg-pool's default is none: once
 * every client is checked out and none comes back, every later checkout
 * waits forever, and so does everything above it. The api did exactly that
 * on the dev rig for sixteen minutes (#3033): the database healthy, the
 * event loop alive, /healthz and /me never answering, and not one log line,
 * because nothing ever failed. With the timeout a starved checkout FAILS
 * with pg's own "timeout exceeded when trying to connect", which is a 5xx
 * the error rate counts and a line that names the cause. The wait a pool
 * can hide is bounded by COBBLR_POOL_CONNECT_TIMEOUT_MS (default 10 s); a
 * caller that knows better passes its own.
 */

export const POOL_CONNECT_TIMEOUT_MS = Number(process.env.COBBLR_POOL_CONNECT_TIMEOUT_MS) || 10_000;

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
      // The last statement, for the starvation report (poolHolders).
      const query = (this.query as (...a: unknown[]) => unknown).bind(this);
      (this as unknown as { query: unknown }).query = (...a: unknown[]) => {
        const q = a[0] as string | { text?: string } | undefined;
        LAST.set(this, { text: typeof q === "string" ? q : (q?.text ?? "?"), at: Date.now() });
        return query(...a);
      };
    }
  };
}

// WHO HOLDS THE POOL. A starved pool used to say only that it was starved:
// "10 open, 0 idle, nothing that holds a client is giving it back". Twice that
// was the whole diagnosis. The dev rig hung for sixteen minutes (#3033), and a
// CI run's meta pool wedged for good (#3666), which took a debugger on a live
// container to trace to a test endpoint that stranded the clients it had
// taken. So every checkout records when it happened and the stack that asked
// for it, every client its last statement, and the starvation line lists each
// held client with both. Capturing a stack is cheap because V8 formats it only
// when read, which here is only when a pool is already starving.
const LAST = new WeakMap<object, { text: string; at: number }>();
const TAKEN = new WeakMap<object, { at: number; site: { stack?: string } }>();

function traceCheckouts(pool: Pool): void {
  const connect = pool.connect as (...a: unknown[]) => unknown;
  (pool as unknown as { connect: unknown }).connect = function tracedConnect(this: Pool, ...a: unknown[]) {
    const site: { stack?: string } = {};
    Error.captureStackTrace(site, tracedConnect);
    const note = (client: unknown) => {
      if (client && typeof client === "object") TAKEN.set(client, { at: Date.now(), site });
    };
    const cb = a[0];
    if (typeof cb === "function") {
      return connect.call(this, (err: Error | undefined, client: unknown, done: unknown) => {
        if (!err) note(client);
        (cb as (...x: unknown[]) => void)(err, client, done);
      });
    }
    return (connect.call(this) as Promise<unknown>).then((client) => {
      note(client);
      return client;
    });
  };
}

const secs = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
const oneLine = (s: string, n = 120) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** Where a checkout came from: the frames outside pg, the pool wrapper and
 *  node itself, which are the ones that name the code holding the client. */
export function callerFrames(stack: string | undefined, n = 4): string {
  const frames = (stack ?? "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim().replace(/^at /, ""))
    .filter((l) => l && !/node_modules|node:internal|\(node:|client-error-guard/.test(l));
  return frames.length ? frames.slice(0, n).join(" <- ") : "(no caller frame)";
}

/** One line per client the pool has handed out and not had back: how long,
 *  the query still in flight if any (a reply never processed), else the last
 *  statement it ran (a caller that never released), and who took it. */
export function poolHolders(pool: Pool, now = Date.now()): string[] {
  const all = (pool as unknown as { _clients?: object[] })._clients ?? [];
  const idle = new Set(((pool as unknown as { _idle?: Array<{ client: object }> })._idle ?? []).map((i) => i.client));
  return all
    .filter((c) => !idle.has(c))
    .map((c) => {
      const taken = TAKEN.get(c);
      const inFlight = (c as { activeQuery?: { text?: string } | null }).activeQuery;
      const last = LAST.get(c);
      const what = inFlight
        ? `a query still in flight: "${oneLine(inFlight.text ?? "?")}"`
        : last
          ? `nothing in flight; last ran "${oneLine(last.text)}" ${secs(now - last.at)} ago`
          : "nothing run on it";
      return `held ${taken ? secs(now - taken.at) : "?"}, ${what}; taken by ${callerFrames(taken?.site.stack)}`;
    });
}

/** The one way to open a pool. `label` names it in the log line. */
export function createPool(config: PoolConfig, label: string): Pool {
  const Base = (config.Client as ClientClass | undefined) ?? Client;
  const pool = new Pool({ connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS, ...config, Client: bornGuarded(label, Base) });
  traceCheckouts(pool);
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
