// A share of one pool that a fan-out's branches draw their connections from
// (#8966). A search asked three kinds at a time, and one kind's list runs
// several queries at once, so three kinds held all five of a server's
// connections and the workspace's next request waited behind the search. A
// budget bounds connections, not branches: every checkout a branch makes,
// however deep, takes a permit first and gives it back on release.
//
// A permit that does not come within `patienceMs` is taken anyway and
// counted: a branch that holds a transaction while it borrows a second
// connection would otherwise wait on a permit only its own siblings can give
// back, and they may be waiting on it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

export class PoolBudget {
  private free: number;
  private readonly queue: Array<() => void> = [];
  /** Checkouts that waited out their patience and went ahead past the budget. */
  overdrawn = 0;

  constructor(readonly pool: Pool, readonly size: number, private readonly patienceMs: number) {
    this.free = size;
  }

  async take(): Promise<() => void> {
    if (this.free > 0) {
      this.free--;
      return this.giveBack();
    }
    const handed = await new Promise<boolean>((resolve) => {
      const go = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(go);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(false);
      }, this.patienceMs);
      timer.unref?.();
      this.queue.push(go);
    });
    if (!handed) {
      this.overdrawn++;
      return () => {};
    }
    return this.giveBack();
  }

  /** A permit's return, once: to the next waiter if there is one, else to the budget. */
  private giveBack(): () => void {
    let given = false;
    return () => {
      if (given) return;
      given = true;
      const next = this.queue.shift();
      if (next) next();
      else this.free++;
    };
  }
}

const budgets = new AsyncLocalStorage<PoolBudget>();

/** The budget the current code runs within, if any: selfFetch carries it into
 *  the request it makes, so an import that writes through the api's own routes
 *  draws on the same share as one that writes directly. */
export function currentBudget(): PoolBudget | undefined {
  return budgets.getStore();
}

/** Run fn with every checkout it makes from `budget.pool` drawn from `budget`. */
export function withinBudget<T>(budget: PoolBudget, fn: () => Promise<T>): Promise<T> {
  return budgets.run(budget, fn);
}

/** Make this pool's checkouts take a permit from the budget they run within, if any. */
export function budgetCheckouts(pool: Pool): void {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  type Done = (err: Error | undefined, client?: PoolClient, release?: () => void) => void;
  (pool as unknown as { connect: unknown }).connect = (cb?: Done) => {
    const budget = budgets.getStore();
    if (!budget || budget.pool !== pool) return cb ? (connect as unknown as (cb: Done) => void)(cb) : connect();
    const checkout = budget.take().then(async (giveBack) => {
      try {
        const client = await connect();
        const release = client.release.bind(client);
        client.release = (err?: Error | boolean) => {
          giveBack();
          return release(err);
        };
        return client;
      } catch (err) {
        giveBack();
        throw err;
      }
    });
    if (!cb) return checkout;
    checkout.then((client) => cb(undefined, client, client.release), (err: Error) => cb(err));
    return undefined;
  };
}
