// One api's workspace connections, held to its share of the server (#6928).
//
// Each workspace has its own pool, so nothing in pg bounds the SUM: a pass that
// walks every workspace at once (the boot's migrations, the sweeps and the
// recurrence scanner, together, right after a roll) held one idle connection
// in each of ~85 workspace databases, and staging refused connections for
// minutes with 99 of 100 in use. The pool cap only asked idle pools to close,
// and skipped every pool handed out in the last few seconds, which in a walk
// is all of them.
//
// So every workspace pool's connect() goes through one gate per api:
// - reusing a connection already open in its own pool always goes through;
// - under the limit, a new connection opens (checked and opened in the same
//   synchronous step, so concurrent callers cannot overshoot together);
// - at the limit, the least-recently-used fully idle pool the caller allows is
//   ended to make room, or the caller waits for a connection to come back;
// - a caller never waits forever: past `waitMs` it opens anyway and says so,
//   which is the old behaviour, so a caller holding one workspace while it
//   waits for another can never deadlock the api;
// - a checkout still waiting when its pool is ended is refused at once with
//   PoolEndedError, never left to pg's timer: pg-pool's end() serves nothing
//   still queued, so a read that queued just before the limit or a release
//   ended its pool waited out connectionTimeoutMillis and answered a 500
//   (#7501, 2026-10-19: 535 of them in fifteen minutes on staging).
import type { Pool, PoolClient } from "pg";

/** A checkout refused because its pool was ended while it waited; the caller
 *  takes a connection from the workspace's live pool instead. */
export class PoolEndedError extends Error {
  constructor() {
    super("the pool was ended while this checkout waited");
    this.name = "PoolEndedError";
  }
}

/** Whether a checkout failed only because its pool ended (here, or by pg's own guard). */
export function isPoolEnded(err: unknown): boolean {
  return err instanceof PoolEndedError || /Cannot use a pool after calling end/.test((err as Error | null)?.message ?? "");
}

// The checkouts each pool has waiting at the limit, not yet given a
// connection. pg-pool does not know of them (they are not in its queue), so
// its own counts read a pool with a read waiting here as idle.
const gateWaiting = new WeakMap<Pool, Set<unknown>>();

/** Nothing borrowed, nothing queued in pg, and nothing waiting at the limit:
 *  the one test every release and eviction asks before ending a pool. A pool
 *  ended with a checkout waiting at the limit refused it, and four refusals in
 *  a row under a busy server answered a fresh workspace's read with a 500
 *  (#7908). */
export function poolIsIdle(pool: Pool): boolean {
  return pool.totalCount === pool.idleCount && pool.waitingCount === 0 && (gateWaiting.get(pool)?.size ?? 0) === 0;
}

const isEnding = (pool: Pool) => {
  const p = pool as unknown as { ended?: boolean; ending?: boolean };
  return !!(p.ended || p.ending);
};

/** A connection from `first`, or, when that pool has ended or ends while the
 *  checkout waits, from the workspace's live pool, asked again each time: under
 *  load the limit can end the live pool too before its checkout starts. Any
 *  other failure is the caller's. */
export async function connectThroughEnds(first: Pool, live: () => Promise<Pool>, attempts = 4): Promise<PoolClient> {
  let pool = first;
  for (let i = 1; ; i++) {
    if (!isEnding(pool)) {
      try {
        return await pool.connect();
      } catch (err) {
        if (!isPoolEnded(err) || i >= attempts) throw err;
      }
    } else if (i > attempts) throw new PoolEndedError();
    pool = await live();
  }
}

export interface ConnectionLimitOptions {
  /** Connections this api may hold across every workspace pool. */
  limit: () => number;
  /** The open pools, least recently used first. */
  pools: () => Iterable<readonly [string, Pool]>;
  /** Whether ending this pool to make room is safe for its holders. */
  evictable: (key: string) => boolean;
  /** End this pool (it is fully idle when called). */
  evict: (key: string) => Promise<unknown>;
  waitMs?: number;
  onOverrun?: (open: number, limit: number) => void;
}

export function createConnectionLimit(opts: ConnectionLimitOptions) {
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiters]) w();
  };
  const open = () => {
    let n = 0;
    for (const [, p] of opts.pools()) n += p.totalCount;
    return n;
  };
  const victim = (except: string) => {
    for (const [k, p] of opts.pools()) {
      if (k === except || p.totalCount === 0) continue;
      if (poolIsIdle(p) && opts.evictable(k)) return k;
    }
    return null;
  };

  /** Open a connection on `pool` once the api has room for it. */
  async function connect(key: string, pool: Pool, doConnect: () => Promise<PoolClient>): Promise<PoolClient> {
    const deadline = Date.now() + (opts.waitMs ?? 15_000);
    for (;;) {
      if (pool.idleCount > 0 || open() < opts.limit()) return doConnect();
      const v = victim(key);
      if (v) {
        await opts.evict(v);
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        opts.onOverrun?.(open(), opts.limit());
        return doConnect();
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          waiters.delete(done);
          resolve();
        };
        const t = setTimeout(done, Math.min(left, 1_000));
        waiters.add(done);
      });
    }
  }

  /** Route every connection `pool` opens, promise or callback form (pool.query
   *  uses the callback), through the limit, and wake waiters when it frees one. */
  function gate(key: string, pool: Pool): void {
    const raw = pool.connect.bind(pool) as () => Promise<PoolClient>;
    type Done = (err?: Error | boolean) => void;
    type Callback = (err: Error | undefined, client?: PoolClient, done?: Done) => void;
    // The checkouts still waiting on this pool, refused the moment it is ended.
    const waiting = new Set<(err: Error) => void>();
    gateWaiting.set(pool, waiting);
    const end = pool.end.bind(pool) as (...a: unknown[]) => unknown;
    (pool as unknown as { end: (...a: unknown[]) => unknown }).end = (...a: unknown[]) => {
      const ended = end(...a);
      for (const refuse of [...waiting]) refuse(new PoolEndedError());
      return ended;
    };
    const checkout = (): Promise<PoolClient> =>
      new Promise<PoolClient>((resolve, reject) => {
        let settled = false;
        const refuse = (err: Error) => {
          if (settled) return;
          settled = true;
          waiting.delete(refuse);
          reject(err);
        };
        waiting.add(refuse);
        connect(key, pool, raw).then(
          (client) => {
            waiting.delete(refuse);
            // Refused already: the caller went to the live pool, so this one goes back.
            if (settled) return void client.release();
            settled = true;
            resolve(client);
          },
          refuse,
        );
      });
    (pool as unknown as { connect: (cb?: Callback) => Promise<PoolClient> | undefined }).connect = (cb?: Callback) => {
      const p = checkout();
      if (!cb) return p;
      p.then(
        (client) => cb(undefined, client, (err) => client.release(err)),
        (err: Error) => cb(err),
      );
      return undefined;
    };
    pool.on("release", wake);
    pool.on("remove", wake);
  }

  return { gate, connect, open, wake };
}
