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
// two api processes never schedule one pass at once; a pass whose lock is held
// elsewhere sits this round out. Each workspace visit also holds its
// workspace lock. A named run takes only those visit locks, so another
// workspace's slow visit cannot hold an explicit run behind the whole round.
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
import { notePassFailure } from "./pass-failures.js";

/** Workspaces open at once across every pass. Default 4: four pools of at
 *  most five clients each is twenty connections at the very worst, well
 *  under what a 100-connection Postgres has left after the meta pool and
 *  live traffic. Printed at boot. */
export const SWEEP_CONCURRENCY = Math.max(1, Number(process.env.COBBLR_SWEEP_CONCURRENCY) || 4);
/** How often the scheduler looks for due passes. A pass's own cadence is
 *  never finer than this. */
export const SWEEP_TICK_MS = Number(process.env.COBBLR_SWEEP_TICK_MS) || 10_000;

/** How a pass's last round went: what /healthz says about it. */
export interface SweepLastRound {
  at: number;
  visited: number;
  failed: number;
  failures: Array<{ orgId: string; message: string }>;
}

interface Registered {
  pass: TenantSweepPass;
  /** Epoch ms of the next round, or null until the scheduler starts. */
  nextDue: number | null;
  running: boolean;
  /** The last round that actually ran (a skipped round leaves it alone). */
  last: SweepLastRound | null;
}

/** Failures kept per round; the count is exact, the names are a sample. */
const FAILURES_KEPT = 5;

const registry = new Map<string, Registered>();

/** A share space nobody has touched for a week holds copies that do not
 *  change, so every pass visiting it on its own cadence is pure idle cost
 *  (share-spaces.md §13). Each pass visits such a space at most once a day,
 *  remembered here per process; a change in it makes it ordinary again on the
 *  next round, and a run naming it is never held back. */
const QUIET_EVERY_MS = 24 * 60 * 60 * 1000;
const quietVisits = new Map<string, Map<string, number>>();
export function quietVisitDue(pass: TenantSweepPass, orgId: string, now: number): boolean {
  const last = quietVisits.get(pass.name)?.get(orgId);
  return last === undefined || now - last >= Math.max(QUIET_EVERY_MS, pass.everyMs);
}
/** The day's visit is spent only by a visit that happened (#7155): a pool
 *  that would not open, a lock that was busy or threw, or a pass that failed
 *  leaves the workspace due, so the short retry reaches it instead of the
 *  next day. */
function noteQuietVisit(pass: TenantSweepPass, orgId: string, now: number): void {
  const seen = quietVisits.get(pass.name) ?? new Map<string, number>();
  quietVisits.set(pass.name, seen);
  seen.set(orgId, now);
}
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
  registry.set(pass.name, { pass, nextDue: existing?.nextDue ?? (started ? firstDue(pass, Date.now()) : null), running: false, last: existing?.last ?? null });
}

/** The first round: `firstAfterMs` when the pass says so, else a random
 *  point inside the cadence, so N hourly passes land across the hour. */
function firstDue(pass: TenantSweepPass, now: number): number {
  return now + (pass.firstAfterMs ?? Math.floor(rand() * pass.everyMs));
}

export function listTenantSweeps(): Array<{ name: string; everyMs: number; nextDue: number | null; running: boolean; last: SweepLastRound | null }> {
  return [...registry.values()].map((r) => ({ name: r.pass.name, everyMs: r.pass.everyMs, nextDue: r.nextDue, running: r.running, last: r.last }));
}

/** What a scheduled round leaves behind for /healthz. Exported so the seam
 *  between a round and the health line is held by a test without a clock. */
export function recordLastRound(name: string, res: TenantSweepRunResult, at: number = Date.now()): void {
  const r = registry.get(name);
  if (!r) return;
  r.last = { at, visited: res.visited, failed: res.failed, failures: res.failures };
}

/** The passes whose last round failed for at least one workspace: the
 *  /healthz line. Empty is healthy; a pass that has not run yet is absent. */
export function failingTenantSweeps(): Array<{ name: string } & SweepLastRound> {
  return [...registry.values()]
    .filter((r) => r.last && r.last.failed > 0)
    .map((r) => ({ name: r.pass.name, ...r.last! }));
}

/** Start the rounds. `startAfterMs` keeps the first round clear of boot. */
export function startTenantSweeps(opts: { startAfterMs?: number } = {}): { stop: () => void } {
  if (started) return started;
  const startAt = Date.now() + (opts.startAfterMs ?? 0);
  for (const r of registry.values()) r.nextDue = firstDue(r.pass, startAt);
  // SINGLE-PROCESS-SAFE: every pass a round walks is held under its own
  // advisory lock for the length of the walk, all of them on one connection
  // (openLockSession), so a second api against the same database sits that
  // pass out.
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
      if (res && !res.skipped) recordLastRound(r.pass.name, res);
    }
  } finally {
    for (const r of due) r.running = false;
  }
}

/** Every registered pass, one round, for the named workspaces: what a
 *  workspace that has been through the scheduler's rounds carries. Tests use
 *  it to compare an old workspace after its heals with a new one, without
 *  depending on whether a round happened to reach the old one yet. */
export async function runAllTenantSweeps(opts: { orgIds: string[]; now?: Date }): Promise<Record<string, TenantSweepRunResult>> {
  const results = await walk(
    [...registry.values()].map((r) => r.pass),
    { now: opts.now ?? new Date(), orgIds: opts.orgIds, waitForLockMs: RUN_NOW_LOCK_WAIT_MS },
  );
  return Object.fromEntries(results);
}

/** Run every pass's `onEnable` for a module just enabled in a workspace, so
 *  the workspace is born with what the pass's first round would give it.
 *  One pass failing is logged and never fails the enable. */
export async function runSweepEnableSteps(
  orgId: string,
  moduleName: string,
  openDb: (orgId: string) => Promise<unknown> = async (id) => (await import("../db/tenant.js")).getTenantDb(id),
): Promise<void> {
  const steps = [...registry.values()].filter((r) => r.pass.module === moduleName && r.pass.onEnable);
  if (!steps.length) return;
  const db = await openDb(orgId);
  for (const r of steps) {
    try {
      await r.pass.onEnable!({ orgId, db, now: new Date() });
    } catch (err) {
      console.error(`[sweeps] ${r.pass.name}: its enable step for org ${orgId} failed:`, (err as Error).message);
    }
  }
}

/** How long a run asked for NOW waits for a pass's lock that a scheduled
 *  round (or another caller) holds. Sitting the round out is right for the
 *  scheduler, whose next tick comes anyway; a caller that asked for a run
 *  and got a silent skip reads the world as if the pass had run. A test door
 *  did exactly that: the retention pass skipped under a concurrent round, and
 *  the test found a day-old job still there, one run in many. */
export const RUN_NOW_LOCK_WAIT_MS = 60_000;
const LOCK_RETRY_MS = 250;

/** Run one pass now: tests and admin doors. A named run waits only for its workspace visits. */
export async function runTenantSweep(name: string, opts: { orgIds?: string[]; now?: Date } = {}): Promise<TenantSweepRunResult> {
  const r = registry.get(name);
  if (!r) throw new Error(`tenant sweep: no pass named "${name}"`);
  const results = await walk([r.pass], { now: opts.now ?? new Date(), orgIds: opts.orgIds, waitForLockMs: RUN_NOW_LOCK_WAIT_MS });
  return results.get(name)!;
}

interface Scoped {
  pass: TenantSweepPass;
  orgs: Set<string>;
  result: TenantSweepRunResult;
  release: () => Promise<void>;
}

/** The first few failures by name; the count on the result stays exact. */
function noteFailure(pass: string, result: TenantSweepRunResult, orgId: string, message: string): void {
  if (result.failures.length < FAILURES_KEPT) result.failures.push({ orgId, message: message.slice(0, 300) });
  notePassFailure(pass, orgId, new Error(message));
}

/** What a walk needs from the world, so the walk itself is a unit test. */
export interface WalkDeps {
  holdLock: (name: string) => Promise<{ release: () => Promise<void> } | null>;
  /** Every workspace (or the ones asked for), oldest first, with what it has
   *  enabled, and whether it is a share space nothing has happened in for a
   *  week (`quiet`). */
  listWorkspaces: (orgIds?: string[]) => Promise<Array<{ id: string; modules: string[]; quiet?: boolean }>>;
  openDb: (orgId: string) => Promise<unknown>;
  releaseDb: (orgId: string) => Promise<void>;
  concurrency: number;
  /** Lets go of the walk's lock connection, after every lock is released. */
  done?: () => Promise<void>;
}

async function realDeps(): Promise<WalkDeps> {
  const { openLockSession } = await import("./exclusive.js");
  // Every lock the walk takes, its passes' and each workspace visit's, on one
  // connection: a connection per lock held about forty for the whole walk.
  const locks = await openLockSession("tenant-sweeps");
  const { meta } = await import("../db/meta.js");
  const { getTenantDb, releaseSweepPool } = await import("../db/tenant.js");
  return {
    holdLock: locks.tryHold,
    done: locks.close,
    listWorkspaces: async (orgIds) => {
      // One meta read for the round: every workspace and what it has enabled.
      const q = sql<{ id: string; modules: string[] | null; quiet: boolean }>`
        select o.id, array_remove(array_agg(m.module_name), null) as modules,
               (o.kind = 'share'
                 and not exists (select 1 from activity_log a where a.org_id = o.id and a.occurred_at > now() - interval '7 days')
                 and not exists (select 1 from share_links l where l.org_id = o.id and l.last_synced_at > now() - interval '7 days')) as quiet
          from orgs o
          left join org_modules m on m.org_id = o.id
         -- A sandbox waiting for its visitor is visited by nothing (sandbox-awaiting.ts).
         where not (o.sandbox and o.trial_expires_at is null)
         ${orgIds ? sql`and o.id = any(${orgIds})` : sql``}
         -- A pooled test workspace a test has checked out is the test's until
         -- it ends: a scheduled round writing into it mid-test rewrote rows
         -- the test had just made (#7282). A test that wants a pass runs it
         -- by name, which names the workspace and still reaches it.
         ${orgIds ? sql`` : sql`and not exists (select 1 from test_org_pool p where p.org_id = o.id and p.status = 'taken')`}
         group by o.id, o.created_at, o.kind
         order by o.created_at asc`;
      return (await q.execute(meta)).rows.map((r) => ({ id: r.id, modules: r.modules ?? [], quiet: r.quiet === true }));
    },
    openDb: getTenantDb,
    releaseDb: releaseSweepPool,
    concurrency: SWEEP_CONCURRENCY,
  };
}

async function walk(passes: TenantSweepPass[], opts: { now: Date; orgIds?: string[]; waitForLockMs?: number }): Promise<Map<string, TenantSweepRunResult>> {
  const deps = await realDeps();
  try {
    return await walkWith(deps, passes, opts);
  } finally {
    await deps.done?.();
  }
}

/** The walk itself: the workspaces in scope for the passes given, visited
 *  once each with every pass that names them, under the concurrency budget. */
export async function walkWith(
  deps: WalkDeps,
  passes: TenantSweepPass[],
  opts: { now: Date; orgIds?: string[]; waitForLockMs?: number },
): Promise<Map<string, TenantSweepRunResult>> {
  const out = new Map<string, TenantSweepRunResult>();
  const lockDeadline = Date.now() + (opts.waitForLockMs ?? 0);
  const scoped: Scoped[] = [];

  // Every pass's lock, or that pass sits this round out.
  for (const pass of passes) {
    const result: TenantSweepRunResult = { visited: 0, failed: 0, backlog: false, stopped: false, results: [], skipped: false, failures: [] };
    out.set(pass.name, result);
    if (opts.orgIds !== undefined) {
      scoped.push({ pass, orgs: new Set(), result, release: async () => {} });
      continue;
    }
    let held: { release: () => Promise<void> } | null = null;
    for (;;) {
      try {
        held = await deps.holdLock(pass.name);
      } catch (err) {
        console.warn(`[tenant-sweeps] ${pass.name}: lock unavailable, skipped this round:`, (err as Error).message);
        break;
      }
      if (held || Date.now() >= lockDeadline) break;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
    if (!held) {
      result.skipped = true;
      continue;
    }
    scoped.push({ pass, orgs: new Set(), result, release: held.release });
  }
  if (scoped.length === 0) return out;

  try {
    let rows: Array<{ id: string; modules: string[]; quiet?: boolean }>;
    try {
      rows = await deps.listWorkspaces(opts.orgIds);
    } catch (err) {
      console.warn("[tenant-sweeps] round skipped, the workspace list could not be read:", (err as Error).message);
      for (const s of scoped) s.result.failed++;
      return out;
    }
    const quiet = new Set(rows.filter((r) => r.quiet).map((r) => r.id));
    for (const s of scoped) {
      const inScope = rows
        .filter((r) => !s.pass.module || r.modules.includes(s.pass.module))
        .filter((r) => opts.orgIds !== undefined || !quiet.has(r.id) || quietVisitDue(s.pass, r.id, opts.now.getTime()))
        .map((r) => r.id);
      let chosen: string[] | null = null;
      // Nothing in scope (a fresh instance, a module nobody turned on): there
      // is nothing to narrow, so a pass's candidates is never asked. Asked with
      // [], a candidates that filters by the list writes `in ()`, which
      // Postgres refuses, and every round logged a failure on a new box (#5367).
      if (inScope.length === 0) continue;
      if (s.pass.candidates) {
        try {
          chosen = await s.pass.candidates(inScope, { named: opts.orgIds !== undefined });
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
    const visitHeld = async (orgId: string, here: Scoped[]) => {
      let db: unknown;
      try {
        db = await deps.openDb(orgId);
      } catch (err) {
        // A workspace being deleted is not a pool that could not open: it
        // is leaving, and nothing about it needs a pass, a retry or a line
        // on /healthz. Every other refusal is a full Postgres, failed for
        // every due pass and backlogged so the drain interval brings it back.
        if ((err as { code?: string }).code === "workspace_deleting") return;
        poolRefusals++;
        for (const s of here) {
          s.result.failed++;
          s.result.backlog = true;
          noteFailure(s.pass.name, s.result, orgId, `pool: ${(err as Error).message}`);
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
            if (opts.orgIds === undefined && quiet.has(orgId)) noteQuietVisit(s.pass, orgId, opts.now.getTime());
            s.result.results.push({ orgId, result: r });
            if (r?.backlog) s.result.backlog = true;
            if (r?.stop) s.result.stopped = true;
          } catch (err) {
            s.result.failed++;
            noteFailure(s.pass.name, s.result, orgId, (err as Error).message);
            console.warn(`[tenant-sweeps] ${s.pass.name}: workspace ${orgId} failed:`, (err as Error).message);
          }
        }
      } finally {
        await deps.releaseDb(orgId).catch(() => {});
      }
    };
    const visit = async (orgId: string) => {
      const here = scoped.filter((s) => s.orgs.has(orgId) && !s.result.stopped);
      if (!here.length) return;
      const deadline = Date.now() + (opts.waitForLockMs ?? 0);
      let lock: { release: () => Promise<void> } | null = null;
      try {
        for (;;) {
          lock = await deps.holdLock(`tenant-sweep-visit:${orgId}`);
          if (lock || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        }
      } catch (err) {
        for (const s of here) {
          s.result.failed++;
          s.result.backlog = true;
          noteFailure(s.pass.name, s.result, orgId, `lock: ${(err as Error).message}`);
        }
        return;
      }
      if (!lock) {
        for (const s of here) s.result.skipped = true;
        return;
      }
      try {
        await visitHeld(orgId, here);
      } finally {
        await lock.release().catch(() => {});
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
  quietVisits.clear();
  started?.stop();
  registry.clear();
}
