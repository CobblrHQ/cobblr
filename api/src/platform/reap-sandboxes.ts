// Delete sandboxes when their hour is up.
//
// PERMANENT RECONCILE — this is not a heal shim. As long as the box hands out
// sandboxes it has to collect them, so it runs forever, on a timer.
//
// Deliberately NOT part of reap-trials.ts, which is the humane path for account
// trials: warn seven days out, wait a grace window, only then delete, and never
// delete what it could not warn. Every one of those protections exists because
// an account trial holds work somebody meant to keep and an address to reach
// them at.
//
// A sandbox has neither. The visitor was told the lifetime before they started,
// there is no address to warn, and nothing in it was ever meant to outlive the
// hour. Running it through the humane path would mean a one-hour workspace
// lingering for ten days, which defeats the only thing that makes handing out
// anonymous databases safe. So: expired means gone.
//
// The safety that matters here is the OPPOSITE one — this must never touch a
// real workspace. Three guards:
//   1. `sandbox = true` — a column only GET /try ever sets, and "keep it"
//      clears the moment a workspace becomes an account trial.
//   2. `trial_expires_at < now` — prod, staging and self-host leave that NULL
//      everywhere, so their rows cannot match even if the flag leaked.
//   3. the whole sweep is off unless COBBLR_TRY_SANDBOX=true.
import { env } from "../env.js";
import { runExclusive } from "./exclusive.js";
import { hardDeleteOrg } from "./delete-org.js";
import { expiredSandboxes, pruneOrphanTokens, sandboxEnabled } from "./try-sandbox.js";
import { reapExpiredExports } from "./try-sandbox-export.js";

/** Bounded per sweep so a backlog is drained over several ticks rather than
 *  dropping a hundred databases in one go on a 4-core box. */
const MAX_PER_SWEEP = 25;

export interface SandboxReapResult {
  found: number;
  deleted: number;
  /** Export artifacts past their window. The only thing that outlives a sandbox,
   *  so it is swept by the same pass that enforces the sandbox's own lifetime. */
  exports: number;
}

export async function reapExpiredSandboxes(now: number = Date.now()): Promise<SandboxReapResult> {
  if (!sandboxEnabled()) return { found: 0, deleted: 0, exports: 0 };

  const expired = await expiredSandboxes(MAX_PER_SWEEP, now);
  let deleted = 0;
  for (const org of expired) {
    try {
      // Drops the tenant database. The token rows cascade with the org.
      await hardDeleteOrg(org.id);
      deleted++;
      console.log(`[reap-sandboxes] ${org.slug} expired and was deleted`);
    } catch (err) {
      // One stuck workspace must not stop the sweep; the next tick retries it.
      console.error(`[reap-sandboxes] could not delete ${org.slug}:`, (err as Error).message);
    }
  }
  if (deleted > 0) {
    try {
      await pruneOrphanTokens();
    } catch (err) {
      console.error("[reap-sandboxes] orphan-token prune failed:", (err as Error).message);
    }
  }
  // "Email me my work" leaves one file behind per person who asked. It is the
  // only thing that outlives a sandbox, so it is swept here rather than
  // somewhere with its own schedule that could quietly stop running.
  let exports = 0;
  try {
    exports = await reapExpiredExports(now);
    if (exports > 0) console.log(`[reap-sandboxes] deleted ${exports} expired export(s)`);
  } catch (err) {
    console.error("[reap-sandboxes] export sweep failed:", (err as Error).message);
  }

  return { found: expired.length, deleted, exports };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the sweep. No-op unless the box hands out sandboxes. */
export function startSandboxReaper(): void {
  if (!sandboxEnabled() || timer) return;
  const intervalMs = env.TRY_SANDBOX_REAP_INTERVAL_MS;
  const run = () => {
    // Every api process starts this timer, and more than one api runs against a
    // single database (the canary channel, and any rolling deploy). Two
    // processes sweeping at once would both call hardDeleteOrg on the same
    // rows — the second one dropping a database that is already gone, or worse
    // racing a redeem. The advisory lock means exactly one process sweeps and
    // the others find it taken and do nothing, which is the same seam the trial
    // reaper uses.
    void runExclusive("platform.reap-sandboxes", async () => {
      await reapExpiredSandboxes();
    }).catch((err) => console.error("[reap-sandboxes] sweep threw:", (err as Error).message));
  };
  // Once on boot: a restart is exactly when a backlog has built up.
  run();
  timer = setInterval(run, intervalMs);
  // Never hold the process open for a cleanup timer.
  timer.unref?.();
  console.log(
    `[reap-sandboxes] on — sweeping every ${Math.round(intervalMs / 1000)}s, ` +
      `sandboxes live ${env.TRY_SANDBOX_TTL_MINUTES}m`,
  );
}
