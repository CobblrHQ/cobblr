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
//   waits for another can never deadlock the api.
import type { Pool, PoolClient } from "pg";

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
      if (p.totalCount === p.idleCount && p.waitingCount === 0 && opts.evictable(k)) return k;
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
    (pool as unknown as { connect: (cb?: Callback) => Promise<PoolClient> | undefined }).connect = (cb?: Callback) => {
      const p = connect(key, pool, raw);
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
