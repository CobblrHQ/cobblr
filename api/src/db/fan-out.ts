import { mapLimit } from "@cobblr/platform-contract/map-limit";
import { getTenantPool } from "./tenant.js";
import { PoolBudget, withinBudget } from "./pool-budget.js";

/** Connections of a workspace's pool a fan-out leaves for its other requests. */
export const FAN_OUT_HEADROOM = 2;
/** How long a branch's checkout waits for a permit before it goes ahead anyway. */
export const FAN_OUT_PATIENCE_MS = 2_000;

/** Each item through fn, results in input order, with the whole fan-out
 *  holding at most the workspace pool's size less FAN_OUT_HEADROOM of its
 *  connections (at least one), however many queries each branch starts: a
 *  workspace search held all five of a server's and the workspace's next
 *  request waited behind it (#8966). `atOnce` runs more branches than that
 *  when each mostly waits on something else (a printer over the network):
 *  their connections still come out of the same share. */
export async function fanOut<T, R>(orgId: string, items: readonly T[], fn: (item: T, i: number) => Promise<R>, opts: { atOnce?: number } = {}): Promise<R[]> {
  const pool = await getTenantPool(orgId);
  const size = Math.max(1, (pool.options.max ?? 1) - FAN_OUT_HEADROOM);
  return withinBudget(new PoolBudget(pool, size, FAN_OUT_PATIENCE_MS), () => mapLimit(items, Math.max(size, opts.atOnce ?? size), fn));
}
