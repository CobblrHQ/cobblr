// Sandboxes made in advance, so arriving is instant and complete.
//
// Building one on demand takes a few seconds - CREATE DATABASE, migrations, two
// bundles, 22 records - and then the ten book covers land over another twenty,
// because they come from a public catalogue that throttles anything faster.
// Reported exactly as it looks: "the pics in bookshelf were largely empty and
// took time to fill in". Nothing was broken; the visitor was simply watching us
// work.
//
// So do the work before anybody is watching. A pooled sandbox is a complete
// workspace - seeded, covers already in place - with `trial_expires_at IS NULL`,
// which the reaper's `trial_expires_at < now` can never match, so it waits
// without being collected and without needing a column or a flag to stay in
// step with. Claiming one starts its hour and mints its link.
//
// The pool is a pure optimisation, exactly like the test-org pool it copies.
// Empty, off, or failing, GET /try/start provisions inline as before, and
// nobody is turned away.
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { env } from "../env.js";
import { runExclusive } from "./exclusive.js";
import { sandboxEnabled, sandboxTtlMs, sandboxCapacity, provisionSandboxWorkspace, handOverSandbox } from "./try-sandbox.js";
import type { ProvisionDeps, SandboxResult, SandboxWorkspace } from "./try-sandbox.js";

export function poolTarget(): number {
  return sandboxEnabled() ? env.TRY_SANDBOX_POOL : 0;
}

/** How many finished sandboxes are waiting for somebody. */
export async function readyCount(): Promise<number> {
  const row = await meta
    .selectFrom("orgs")
    .select(({ fn }) => [fn.countAll<string>().as("n")])
    .where("sandbox", "=", true)
    .where("trial_expires_at", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Take one, atomically.
 *
 *  SKIP LOCKED rather than a read-then-write: more than one api process serves
 *  this box, and two visitors arriving together must not be handed the same
 *  workspace. A row another transaction is already taking is skipped instead of
 *  waited for, so a burst spreads across the pool rather than queueing on its
 *  first row. */
export async function claimPooledSandbox(): Promise<SandboxWorkspace | null> {
  const claimed = await sql<{ id: string; slug: string }>`
    update orgs set trial_expires_at = now()
     where id = (
       select id from orgs
        where sandbox = true and trial_expires_at is null
        order by created_at asc
        for update skip locked
        limit 1
     )
    returning id, slug
  `.execute(meta);
  const row = claimed.rows[0];
  if (!row) return null;

  const owner = await meta
    .selectFrom("org_memberships")
    .select("user_id")
    .where("org_id", "=", row.id)
    .executeTakeFirst();
  if (!owner) return null; // half-built: leave it for the sweep below
  return { orgId: row.id, slug: row.slug, userId: owner.user_id };
}

/** A ready sandbox if there is one, otherwise null and the caller builds. */
export async function takeFromPool(now: number = Date.now()): Promise<SandboxResult | null> {
  if (poolTarget() <= 0) return null;
  const ws = await claimPooledSandbox();
  if (!ws) return null;
  return handOverSandbox(ws, now);
}

export interface PoolDeps extends ProvisionDeps {
  /** Fill the new workspace, so a pooled sandbox is complete before anyone
   *  arrives - covers included, which is the whole point. */
  seed: (ws: SandboxWorkspace) => Promise<void>;
}

/** Build at most one per tick.
 *
 *  Deliberately not a burst: each one is a CREATE DATABASE behind a Postgres
 *  template lock, and filling an empty pool all at once would be
 *  indistinguishable from the traffic spike the pool exists to absorb. */
export async function topUpPool(deps: PoolDeps): Promise<boolean> {
  const target = poolTarget();
  if (target <= 0) return false;
  if ((await readyCount()) >= target) return false;

  // The population ceiling applies to sandboxes nobody has yet, too. Without
  // this the top-up is a loop whose only brake is its own bookkeeping being
  // correct - and when that bookkeeping was wrong it made a database every
  // twenty seconds and would have kept going. A cap the loop cannot reason its
  // way past is the difference between a bug and an outage.
  const cap = await sandboxCapacity();
  if (!cap.ok) {
    console.warn(`[try-pool] at capacity (${cap.live}/${cap.max}) - not building`);
    return false;
  }

  const before = await readyCount();
  const ws = await provisionSandboxWorkspace(deps);
  try {
    await deps.seed(ws);
  } catch (err) {
    // A sandbox with nothing in it is still usable, and refusing to pool it
    // would mean an empty pool every time the catalogue is having a bad day.
    console.error("[try-pool] seed failed, pooling it empty:", (err as Error).message);
  }

  // Did the thing we just built actually become claimable?
  //
  // This is not paranoia about the database. The first version of this pool
  // left the tier's own thirty-day stamp on trial_expires_at, and NULL is what
  // marks a sandbox as waiting - so every sandbox it built was invisible to
  // itself. readyCount stayed at zero, the loop concluded the pool was empty,
  // and it built another every twenty seconds. Eight databases in three
  // minutes, not one of them claimable, and nothing anywhere threw.
  //
  // A loop whose only brake is its own bookkeeping being right needs to check
  // that the bookkeeping is right. It stops rather than carrying on, because a
  // pool that has quietly stopped filling is a slow morning; one that cannot
  // see its own work is a database every tick until the disk goes.
  if ((await readyCount()) <= before) {
    stop();
    console.error(
      `[try-pool] STOPPED: built ${ws.slug} and the ready count did not move (${before}). ` +
        `Something it just wrote is not what claiming looks for - refusing to build more.`,
    );
    return false;
  }

  console.log(`[try-pool] ready: ${ws.slug}`);
  return true;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Stop building. Used by the self-check below, and safe to call twice. */
export function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function startSandboxPool(deps: PoolDeps): void {
  if (poolTarget() <= 0 || timer) return;
  const run = () =>
    void runExclusive("platform.try-sandbox-pool", async () => {
      // One per tick, and the tick is short, so an empty pool fills steadily.
      await topUpPool(deps);
    }).catch((err) => console.error("[try-pool] top-up threw:", (err as Error).message));
  run();
  timer = setInterval(run, env.TRY_SANDBOX_POOL_INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[try-pool] on — keeping ${poolTarget()} ready, sandboxes live ${Math.round(sandboxTtlMs() / 60_000)}m`,
  );
}
