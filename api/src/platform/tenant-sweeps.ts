// One walk of the workspaces for every cross-tenant pass, with one budget.
//
// THE PROBLEM THIS EXISTS FOR. Every self-healing or periodic pass walked
// all workspaces on its own timer with its own pool discipline: the pictures
// sweep, the retrim and the two heals riding behind it, lists' expiry,
// purchases' arrival, cadence, maintenance, inventory's burn rate, the
// retention sweep, digifab's pump, bundle-updates. Each was correct alone.
// Together, on the dev rig with 352 workspaces against a 100-connection
// Postgres, they started within minutes of boot and refused 811 connections
// in six hours ("remaining connection slots are reserved", #3036), and the
// next pass written would have made it worse.
//
// THE SHAPE. A pass registers (name, cadence, page rule, the per-workspace
// visit) and never owns a timer. A round runs every TICK_MS: every pass that
// is due is walked together, in one order, and a workspace's pool is opened
// at most once per visit for every due pass, then released on the way out
// (db/tenant.ts releaseSweepPool). At most SWEEP_CONCURRENCY workspaces are
// open at a time, whatever the number of passes. Each pass's first round is
// spread over its cadence rather than fired at t+0, so nothing storms at
// boot, and the hourly bundle-updates lands off the exact hour. Every pass
// holds its own advisory lock for the length of the walk (exclusive.ts), so
// two api processes never walk one pass at once; a pass whose lock is held
// elsewhere sits this round out.
//
// A visit that throws fails that workspace for that pass and the walk goes
// on; a workspace whose pool cannot open (a full Postgres) is logged once per
// round and every due pass sees it as backlog, so it is visited again after
// drainMs rather than a full cadence later.
//
// lint:tenant-sweep-registered refuses a new bare loop over the workspaces
// reaching tenants.getDb / withDb outside this file, so the next pass is a
// registration.
import { sql } from "kysely";
import type {
  PlatformSweeps,
  TenantSweepPass,
  TenantSweepRunResult,
  TenantSweepVisitResult,
} from "@cobblr/platform-contract";
import { Gate } from "../db/sweep-gate.js";

/** Workspaces open at once across every pass. Default 4: four pools of at
 *  most five clients each is twenty connections at the very worst, well
 *  under what a 100-connection Postgres has left after the meta pool and
 *  live traffic. Printed at boot. */
export const SWEEP_CONCURRENCY = Math.max(1, Number(process.env.COBBLR_SWEEP_CONCURRENCY) || 4);
/** How often the scheduler looks for due passes. A pass's own cadence is
 *  never finer than this. */
export const SWEEP_TICK_MS = Number(process.env.COBBLR_SWEEP_TICK_MS) || 10_000;

interface Registered {
  pass: TenantSweepPass;
  /** Epoch ms of the next round, or null until the scheduler starts. */
  nextDue: number | null;
  running: boolean;
}

const registry = new Map<string, Registered>();
let started: { stop: () => void } | null = null;
let rand: () => number = Math.random;

/** Tests pin the stagger. */
export function setSweepRandomForTests(fn: () => number): void {
  rand = fn;
}

export function registerTenantSweep(pass: TenantSweepPass): void {
  if (!/^[a-z0-9-]+\.[a-z0-9-]+$/.test(pass.name)) throw new Error(`tenant sweep: name must be <module>.<pass>, got "${pass.name}"`);
  if (!(pass.everyMs > 0)) throw new Error(`tenant sweep ${pass.name}: everyMs must be > 0`);
  const existing = registry.get(pass.name);
  registry.set(pass.name, { pass, nextDue: existing?.nextDue ?? (started ? firstDue(pass, Date.now()) : null), running: false });
}

/** The first round: `firstAfterMs` when the pass says so, else a random
 *  point inside the cadence, so N hourly passes land across the hour. */
function firstDue(pass: TenantSweepPass, now: number): number {
  return now + (pass.firstAfterMs ?? Math.floor(rand() * pass.everyMs));
}

export function listTenantSweeps(): Array<{ name: string; everyMs: number; nextDue: number | null; running: boolean }> {
  return [...registry.values()].map((r) => ({ name: r.pass.name, everyMs: r.pass.everyMs, nextDue: r.nextDue, running: r.running }));
}

/** Start the rounds. `startAfterMs` keeps the first round clear of boot. */
export function startTenantSweeps(opts: { startAfterMs?: number } = {}): { stop: () => void } {
  if (started) return started;
  const startAt = Date.now() + (opts.startAfterMs ?? 0);
  for (const r of registry.values()) r.nextDue = firstDue(r.pass, startAt);
  // SINGLE-PROCESS-SAFE: every pass a round walks is held under its own
  // advisory lock for the length of the walk (tryHoldExclusive), so a second
  // api against the same database sits that pass out.
  const timer = setInterval(() => {
    void round(Date.now()).catch((err) => console.error("[tenant-sweeps] round failed:", (err as Error).stack ?? (err as Error).message));
  }, SWEEP_TICK_MS);
  timer.unref?.();
  const names = [...registry.keys()];
  console.log(`[tenant-sweeps] ${names.length} pass(es) registered, ${SWEEP_CONCURRENCY} workspace(s) open at a time, first rounds spread over each cadence: ${names.join(", ")}`);
  started = {
    stop: () => {
      clearInterval(timer);
      started = null;
      for (const r of registry.values()) r.nextDue = null;
    },
  };
  return started;
}

/** One round: every pass that is due, walked together. */
async function round(now: number): Promise<void> {
  const due = [...registry.values()].filter((r) => r.nextDue !== null && r.nextDue <= now && !r.running);
  if (due.length === 0) return;
  for (const r of due) r.running = true;
  try {
    const results = await walk(
      due.map((r) => r.pass),
      { now: new Date(now) },
    );
    for (const r of due) {
      const res = results.get(r.pass.name);
      const drain = res && !res.skipped && res.backlog && r.pass.drainMs ? r.pass.drainMs : r.pass.everyMs;
      // A pass another process held is tried again next tick, not a cadence later.
      r.nextDue = res?.skipped ? Date.now() + SWEEP_TICK_MS : Date.now() + drain;
    }
  } finally {
    for (const r of due) r.running = false;
  }
}

/** Run one pass now: tests and admin doors. */
export async function runTenantSweep(name: string, opts: { orgIds?: string[]; now?: Date } = {}): Promise<TenantSweepRunResult> {
  const r = registry.get(name);
  if (!r) throw new Error(`tenant sweep: no pass named "${name}"`);
  const results = await walk([r.pass], { now: opts.now ?? new Date(), orgIds: opts.orgIds });
  return results.get(name)!;
}

interface Scoped {
  pass: TenantSweepPass;
  orgs: Set<string>;
  result: TenantSweepRunResult;
  release: () => Promise<void>;
}

/** What a walk needs from the world, so the walk itself is a unit test. */
export interface WalkDeps {
  holdLock: (name: string) => Promise<{ release: () => Promise<void> } | null>;
  /** Every workspace (or the ones asked for), oldest first, with what it has enabled. */
  listWorkspaces: (orgIds?: string[]) => Promise<Array<{ id: string; modules: string[] }>>;
  openDb: (orgId: string) => Promise<unknown>;
  releaseDb: (orgId: string) => Promise<void>;
  concurrency: number;
}

async function realDeps(): Promise<WalkDeps> {
  const { tryHoldExclusive } = await import("./exclusive.js");
  const { meta } = await import("../db/meta.js");
  const { getTenantDb, releaseSweepPool } = await import("../db/tenant.js");
  return {
    holdLock: tryHoldExclusive,
    listWorkspaces: async (orgIds) => {
      // One meta read for the round: every workspace and what it has enabled.
      const q = sql<{ id: string; modules: string[] | null }>`
        select o.id, array_remove(array_agg(m.module_name), null) as modules
          from orgs o
          left join org_modules m on m.org_id = o.id
         ${orgIds ? sql`where o.id = any(${orgIds})` : sql``}
         group by o.id, o.created_at
         order by o.created_at asc`;
      return (await q.execute(meta)).rows.map((r) => ({ id: r.id, modules: r.modules ?? [] }));
    },
    openDb: getTenantDb,
    releaseDb: releaseSweepPool,
    concurrency: SWEEP_CONCURRENCY,
  };
}

async function walk(passes: TenantSweepPass[], opts: { now: Date; orgIds?: string[] }): Promise<Map<string, TenantSweepRunResult>> {
  return walkWith(await realDeps(), passes, opts);
}

/** The walk itself: the workspaces in scope for the passes given, visited
 *  once each with every pass that names them, under the concurrency budget. */
export async function walkWith(
  deps: WalkDeps,
  passes: TenantSweepPass[],
  opts: { now: Date; orgIds?: string[] },
): Promise<Map<string, TenantSweepRunResult>> {
  const out = new Map<string, TenantSweepRunResult>();
  const scoped: Scoped[] = [];

  // Every pass's lock, or that pass sits this round out.
  for (const pass of passes) {
    const result: TenantSweepRunResult = { visited: 0, failed: 0, backlog: false, stopped: false, results: [], skipped: false };
    out.set(pass.name, result);
    let held: { release: () => Promise<void> } | null = null;
    try {
      held = await deps.holdLock(pass.name);
    } catch (err) {
      console.warn(`[tenant-sweeps] ${pass.name}: lock unavailable, skipped this round:`, (err as Error).message);
    }
    if (!held) {
      result.skipped = true;
      continue;
    }
    scoped.push({ pass, orgs: new Set(), result, release: held.release });
  }
  if (scoped.length === 0) return out;

  try {
    let rows: Array<{ id: string; modules: string[] }>;
    try {
      rows = await deps.listWorkspaces(opts.orgIds);
    } catch (err) {
      console.warn("[tenant-sweeps] round skipped, the workspace list could not be read:", (err as Error).message);
      for (const s of scoped) s.result.failed++;
      return out;
    }
    for (const s of scoped) {
      const inScope = rows.filter((r) => !s.pass.module || r.modules.includes(s.pass.module)).map((r) => r.id);
      let chosen: string[] | null = null;
      if (s.pass.candidates) {
        try {
          chosen = await s.pass.candidates(inScope);
        } catch (err) {
          console.warn(`[tenant-sweeps] ${s.pass.name}: candidates failed, visiting every workspace in scope:`, (err as Error).message);
        }
      }
      const allowed = new Set(inScope);
      for (const id of chosen ?? inScope) if (allowed.has(id)) s.orgs.add(id);
    }
    const order = rows.map((r) => r.id).filter((id) => scoped.some((s) => s.orgs.has(id)));

    const gate = new Gate(deps.concurrency);
    let poolRefusals = 0;
    const visit = async (orgId: string) => {
      const here = scoped.filter((s) => s.orgs.has(orgId) && !s.result.stopped);
      if (here.length === 0) return;
      let db: unknown;
      try {
        db = await deps.openDb(orgId);
      } catch (err) {
        poolRefusals++;
        for (const s of here) {
          s.result.failed++;
          s.result.backlog = true;
        }
        if (poolRefusals === 1) console.warn(`[tenant-sweeps] workspace ${orgId} could not be opened; every due pass will come back for it:`, (err as Error).message);
        return;
      }
      try {
        for (const s of here) {
          if (s.result.stopped) continue;
          try {
            const r = (await s.pass.visit({ orgId, db, now: opts.now })) as TenantSweepVisitResult | void;
            s.result.visited++;
            s.result.results.push({ orgId, result: r });
            if (r?.backlog) s.result.backlog = true;
            if (r?.stop) s.result.stopped = true;
          } catch (err) {
            s.result.failed++;
            console.warn(`[tenant-sweeps] ${s.pass.name}: workspace ${orgId} failed:`, (err as Error).message);
          }
        }
      } finally {
        await deps.releaseDb(orgId).catch(() => {});
      }
    };
    // The budget: `concurrency` workspaces in flight, the rest queued.
    await Promise.all(order.map((orgId) => gate.run(() => visit(orgId))));
    if (poolRefusals > 1) console.warn(`[tenant-sweeps] ${poolRefusals} workspace(s) could not be opened this round; they are visited again after the drain interval`);
  } finally {
    await Promise.all(scoped.map((s) => s.release().catch(() => {})));
  }
  return out;
}

export const tenantSweeps: PlatformSweeps = {
  register: registerTenantSweep,
  run: runTenantSweep,
};

/** Tests: forget every pass (the registry is process-wide). */
export function resetTenantSweepsForTests(): void {
  started?.stop();
  registry.clear();
}
