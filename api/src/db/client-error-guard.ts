import { Client, Pool, types } from "pg";
import type { ClientConfig, CustomTypesConfig, PoolConfig } from "pg";
import { currentRequestScope, noteMetaStatement } from "../lib/request-context.js";

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

/** Postgres's `date`: a calendar day with no hour and no zone. */
export const PG_DATE_OID = 1082;

/**
 * A `date` column arrives as its `YYYY-MM-DD` text, never a Date (#5759).
 * pg's default turns it into a Date at the SERVER's local midnight, which is
 * an instant: on a box east of Greenwich `.toISOString().slice(0, 10)` reads
 * it as the day before, and every module typed the same column its own way
 * (`Date` in one db.ts, `string` in the next) and repaired it its own way.
 * A day stays a day from the database to the person; `@cobblr/platform-contract/day`
 * reads it, shows it and counts to it. Applied here because every client is
 * born here, and per client rather than on pg's global table so a second copy
 * of pg in the tree cannot miss it.
 */
export const DAYS_STAY_DAYS: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === PG_DATE_OID && format !== "binary" ? (value: string) => value : types.getTypeParser(oid, format)) as CustomTypesConfig["getTypeParser"],
};

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
        const text = typeof q === "string" ? q : (q?.text ?? "?");
        LAST.set(this, { text, at: Date.now() });
        // Counted against the request that asked, for the per-request bound (#4876).
        if (label === "meta-pool") noteMetaStatement(text);
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
const TAKEN = new WeakMap<object, { at: number; site: { stack?: string }; by?: string }>();
// Who is waiting, by request (requestLabel), so the worst moment can count the
// burst on both sides: the requests holding every client and the requests in
// the queue behind them (#4876: holders named only queries, "all 0s").
const WAITING = new WeakMap<Pool, Map<string, number>>();

/** The worst moment a pool has had: the most callers waiting at once, when,
 *  and who held every client right then. Taken by the checkout that has to
 *  wait at a new high, so a burst that drains between two samples is still
 *  named (#4876: CI read "63 waiting, holders: none captured"). */
export interface PoolPeak {
  waiting: number;
  at: string;
  holders: string[];
  /** The requests at that moment, most first: "34 × GET /orgs/:slug/x (a.test.ts)",
   *  holding a client or waiting for one. This is what names a burst. */
  requests: string[];
}
const PEAK = new WeakMap<Pool, PoolPeak>();

/** The pool's worst moment so far, or null if no caller has ever waited. */
export function poolPeak(pool: Pool): PoolPeak | null {
  return PEAK.get(pool) ?? null;
}

function notePeak(pool: Pool): void {
  const max = pool.options.max ?? 10;
  if (pool.idleCount > 0 || pool.totalCount < max) return; // this caller gets a client without waiting
  const waiting = pool.waitingCount + 1;
  const prev = PEAK.get(pool);
  if (prev && prev.waiting >= waiting) return;
  PEAK.set(pool, { waiting, at: new Date().toISOString(), holders: poolHolders(pool).slice(0, 12), requests: poolRequests(pool) });
}

/** The requests holding the pool's clients or waiting for one, counted, most
 *  first. A checkout outside a request (a timer, a boot pass) counts as such. */
export function poolRequests(pool: Pool, top = 8): string[] {
  const n = new Map<string, number>();
  const add = (k: string, by = 1) => n.set(k, (n.get(k) ?? 0) + by);
  const all = (pool as unknown as { _clients?: object[] })._clients ?? [];
  const idle = new Set(((pool as unknown as { _idle?: Array<{ client: object }> })._idle ?? []).map((i) => i.client));
  for (const c of all) if (!idle.has(c)) add(`holding: ${TAKEN.get(c)?.by ?? "no request (a timer or a boot pass)"}`);
  for (const [k, v] of WAITING.get(pool) ?? []) if (v > 0) add(`waiting: ${k}`, v);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([k, v]) => `${v} × ${k}`);
}

function traceCheckouts(pool: Pool): void {
  const connect = pool.connect as (...a: unknown[]) => unknown;
  (pool as unknown as { connect: unknown }).connect = function tracedConnect(this: Pool, ...a: unknown[]) {
    const site: { stack?: string } = {};
    Error.captureStackTrace(site, tracedConnect);
    const by = currentRequestScope()?.label ?? "no request (a timer or a boot pass)";
    const max = this.options.max ?? 10;
    const waits = this.idleCount === 0 && this.totalCount >= max;
    let queue = WAITING.get(this);
    if (!queue) WAITING.set(this, (queue = new Map()));
    if (waits) queue.set(by, (queue.get(by) ?? 0) + 1);
    notePeak(this);
    let left = !waits;
    const leave = () => {
      if (left) return;
      left = true;
      const v = (queue!.get(by) ?? 1) - 1;
      if (v > 0) queue!.set(by, v);
      else queue!.delete(by);
    };
    const note = (client: unknown) => {
      leave();
      if (client && typeof client === "object") TAKEN.set(client, { at: Date.now(), site, by });
    };
    const cb = a[0];
    if (typeof cb === "function") {
      return connect.call(this, (err: Error | undefined, client: unknown, done: unknown) => {
        if (!err) note(client);
        else leave();
        (cb as (...x: unknown[]) => void)(err, client, done);
      });
    }
    return (connect.call(this) as Promise<unknown>).then(
      (client) => {
        note(client);
        return client;
      },
      (err: unknown) => {
        leave();
        throw err;
      },
    );
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
      return `held ${taken ? secs(now - taken.at) : "?"}, ${what}; for ${taken?.by ?? "?"}; taken by ${callerFrames(taken?.site.stack)}`;
    });
}

/** The one way to open a pool. `label` names it in the log line. */
export function createPool(config: PoolConfig, label: string): Pool {
  const Base = (config.Client as ClientClass | undefined) ?? Client;
  // `types` on the pool, which hands its options to every client it makes:
  // never re-spread there, because pg-pool keeps the password on them as a
  // hidden property and a copy would arrive without it.
  const pool = new Pool({ connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS, types: DAYS_STAY_DAYS, ...config, Client: bornGuarded(label, Base) });
  traceCheckouts(pool);
  // pg-pool re-emits an idle client's error on the pool and, being an
  // EventEmitter, throws if nobody listens there either. The client's own
  // listener already logged it; this one only keeps the pool's emit harmless.
  pool.on("error", () => {});
  return pool;
}

/** The one way to open a bare client (superuser work, a maintenance DB). */
export function createClient(config: ClientConfig | string, label: string): Client {
  const base: ClientConfig = typeof config === "string" ? { connectionString: config } : config;
  const client = new Client({ ...base, types: base.types ?? DAYS_STAY_DAYS });
  client.on("error", onClientError(label));
  // A connection opened for one request (a handshake, a password exchange, a
  // disconnect) is counted against it like a statement, so a per-operation
  // bound sees it: opening one per record deleted was most of that delete's
  // time (#5286).
  const connect = client.connect.bind(client) as unknown as (...a: unknown[]) => unknown;
  (client as unknown as { connect: unknown }).connect = (...a: unknown[]) => {
    noteMetaStatement(`(new connection: ${label.split(" ")[0]})`);
    return connect(...a);
  };
  return client;
}
