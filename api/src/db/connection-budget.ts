// How many connections this api may hold, read from the server it talks to.
//
// The pool sizes were constants: 10 for meta, 5 per workspace, up to 50
// workspace pools, 8 of them for the sweeps. That is 260 at the worst, written
// for CI's 400-connection Postgres. Staging runs on 100, so a burst of review
// agents across a dozen workspaces plus the hourly sweeps ran it out, and every
// list on staging failed with "sorry, too many clients already" (2k to 6k
// refusals a burst, for days). A blue-green roll makes it worse: two apis hold
// pools on the one server at once.
//
// So at boot the api asks the server for max_connections, keeps the slots
// Postgres reserves and a little headroom out, halves the rest for the two apis
// a roll overlaps, and sizes its workspace pools and sweeps to fit. A server
// with room changes nothing: the configured caps stay the ceiling.
//
// And a refusal is counted, so /healthz can say so and a roll that drew one
// fails instead of reading clean.

/** How long a pooled connection may sit idle before the pool closes it.
 *  Every api-side pool uses it, with no minimum kept open: in a roll the old
 *  api's quiet pools give their connections back within seconds rather than
 *  holding them beside the new api's (#6928). */
export const IDLE_RELEASE_MS = 10_000;

/** What the server allows, what this api holds outside workspace pools, and
 *  the configured ceilings. */
export interface BudgetInputs {
  maxConnections: number;
  reserved: number;
  metaPoolMax: number;
  /** Connections held for advisory locks on cobblr_meta, outside the meta
   *  pool: the warm lock pool and the sweep walk's lock session. */
  lockConnections?: number;
  tenantPoolMax: number;
  configuredTenantPools: number;
  configuredSweepPools: number;
  /** How many apis share the server at once: two while a roll overlaps them. */
  apis?: number;
}

export interface Budget {
  perApi: number;
  tenantPools: number;
  sweepPools: number;
  /** The most this api can hold at once with the sizes chosen: meta pool,
   *  lock connections and every workspace pool full. */
  worstCase: number;
  /** True when that worst case, for every api a roll overlaps, fits what the
   *  server allows after its reserved slots and the headroom. */
  fits: boolean;
  /** True when a configured ceiling was lowered to fit. */
  lowered: boolean;
}

const HEADROOM = 5;

export function connectionBudget(i: BudgetInputs): Budget {
  const apis = Math.max(1, i.apis ?? 2);
  const perApi = Math.max(0, Math.floor((i.maxConnections - i.reserved - HEADROOM) / apis));
  const outside = i.metaPoolMax + (i.lockConnections ?? 0);
  const room = Math.max(0, perApi - outside);
  const fitPools = Math.max(2, Math.floor(room / Math.max(1, i.tenantPoolMax)));
  const tenantPools = Math.min(i.configuredTenantPools, fitPools);
  // The sweeps share the workspace pools with people; never more than half.
  const sweepPools = Math.max(1, Math.min(i.configuredSweepPools, Math.floor(tenantPools / 2)));
  const worstCase = outside + tenantPools * i.tenantPoolMax;
  return {
    perApi,
    tenantPools,
    sweepPools,
    worstCase,
    fits: apis * worstCase <= i.maxConnections - i.reserved - HEADROOM,
    lowered: tenantPools !== i.configuredTenantPools || sweepPools !== i.configuredSweepPools,
  };
}

/** pg-pool's answer when no connection came free within the pool's connect timeout. */
export function isPoolAcquireTimeout(err: unknown): boolean {
  return (err as Error | null)?.message === "timeout exceeded when trying to connect";
}

/** Postgres's answer when it has no connection left to give (53300). */
export function isConnectionRefusal(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "53300";
}

const refusals: number[] = [];
const WINDOW_MS = 10 * 60 * 1000;
let lastRefusalAt: number | null = null;

export function noteConnectionRefused(now: number = Date.now()): void {
  refusals.push(now);
  lastRefusalAt = now;
  while (refusals.length && (refusals[0] ?? now) < now - WINDOW_MS) refusals.shift();
}

/** When the newest refusal came, or null for none since boot: a roll counts
 *  only the ones after it stopped the older api. */
export function lastConnectionRefusal(): string | null {
  return lastRefusalAt === null ? null : new Date(lastRefusalAt).toISOString();
}

/** Refusals in the last ten minutes. */
export function connectionRefusals(now: number = Date.now()): number {
  while (refusals.length && (refusals[0] ?? now) < now - WINDOW_MS) refusals.shift();
  return refusals.length;
}

let applied: (Budget & { maxConnections: number }) | null = null;

export function appliedBudget(): (Budget & { maxConnections: number }) | null {
  return applied;
}

export function recordAppliedBudget(b: Budget & { maxConnections: number }): void {
  applied = b;
}
