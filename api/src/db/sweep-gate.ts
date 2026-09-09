// How many tenant pools the sweeps may hold open at once, across the process.
//
// Every hourly sweep (inventory's burn rate, lists' expiry, cadence,
// maintenance, receipt tracking, bundle updates, ...) walks every workspace
// through tenants.withDb, which opens that tenant's pool and closes it when
// the closure returns. Each release is correct on its own; the problem is the
// sum. Several sweeps tick at the same minute, each opens pools as fast as it
// iterates, and a box with 471 workspaces briefly holds hundreds of
// connections against a 100-connection Postgres - and a signup that lands in
// that window fails to provision ("remaining connection slots are reserved
// for roles with the SUPERUSER attribute", dev rig, 2026-09-09).
//
// So the cap lives in the one place every sweep already passes through, not
// in each sweep. A sweep that wants a pool waits its turn; nothing about its
// code changes, and a sweep written next year is capped the day it uses
// withDb. Default 8 pools × the per-tenant max of 5 = 40 connections from
// sweeps at the very worst, leaving the rest for people.

export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`Gate: limit must be >= 1, got ${limit}`);
  }
  /** How many are through right now. */
  get held(): number {
    return this.active;
  }
  /** How many are waiting their turn. */
  get queued(): number {
    return this.waiting.length;
  }
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }
  /** Run `fn` inside the gate; the slot is released however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** The process-wide gate the sweeps share. `COBBLR_SWEEP_POOL_CONCURRENCY`
 *  overrides the default of 8. */
export const sweepGate = new Gate(Number(process.env.COBBLR_SWEEP_POOL_CONCURRENCY) || 8);
