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
import { currentRequestScope } from "../lib/request-context.js";

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

/** Connections of a pool that work done after its request answered leaves to
 *  the requests still waiting for theirs. */
export const AFTER_ANSWER_HEADROOM = 2;
const AFTER_ANSWER_PATIENCE_MS = 2_000;
const afterAnswer = new WeakMap<Pool, PoolBudget>();

/** The share of a pool that every request's after-answer work draws on
 *  together: a write answers, then keeps working on what it set off (its
 *  activity, its events, what reads it next), and a burst of them held a
 *  workspace's pool after every one had answered while the next page
 *  someone opened waited behind work nobody was waiting for (#8978). A pool
 *  too small to leave the headroom has no share: it would bound nothing. */
function afterAnswerBudget(pool: Pool): PoolBudget | undefined {
  const max = pool.options.max ?? 1;
  if (max <= AFTER_ANSWER_HEADROOM) return undefined;
  let budget = afterAnswer.get(pool);
  if (!budget) afterAnswer.set(pool, (budget = new PoolBudget(pool, max - AFTER_ANSWER_HEADROOM, AFTER_ANSWER_PATIENCE_MS)));
  return budget;
}

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

type Done = (err: Error | undefined, client?: PoolClient, release?: () => void) => void;
type Connect = (cb?: Done) => Promise<PoolClient> | undefined;
const beneath = Symbol("the checkout beneath the budget");
type Budgeted = { connect: Connect; [beneath]?: Connect };

/** Make this pool's checkouts take a permit from the budget they run within, if any. */
export function budgetCheckouts(pool: Pool): void {
  const p = pool as unknown as Budgeted;
  p[beneath] = pool.connect.bind(pool) as Connect;
  const connect = () => p[beneath]!() as Promise<PoolClient>;
  p.connect = (cb?: Done) => {
    const fanOut = budgets.getStore();
    const budget = fanOut && fanOut.pool === pool ? fanOut : currentRequestScope()?.answered ? afterAnswerBudget(pool) : undefined;
    if (!budget) return p[beneath]!(cb);
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

/** Route a pool's checkouts through `wrap` beneath its budget, if it has one:
 *  the api's connection limit checks and opens in one step, and a permit wait
 *  in front of that step let 85 workspace pools open 85 connections against a
 *  limit of 25. */
export function beneathBudget(pool: Pool, wrap: (inner: Connect) => Connect): void {
  const p = pool as unknown as Budgeted;
  if (p[beneath]) p[beneath] = wrap(p[beneath]);
  else p.connect = wrap(pool.connect.bind(pool) as Connect);
}
