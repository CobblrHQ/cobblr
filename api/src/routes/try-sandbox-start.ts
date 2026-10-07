// Making a sandbox and handing it over: one path for every door that makes one.
//
// The public door (/try/start) runs it after the visitor passes the challenge;
// an operator's mint from the box (cli/try-sandbox.ts) runs it after naming who
// and why. Two copies of these steps would drift (the pool, the seed, the cap),
// and a sandbox made one way would stop looking like one made the other.
import { env } from "../env.js";
import { enableDefaultModulesForOrg } from "../modules/enable.js";
import { handOverSandbox, provisionSandboxWorkspace, sandboxCapacity, type SandboxResult } from "../platform/try-sandbox.js";
import { takeFromPool } from "../platform/try-sandbox-pool.js";
import { seedSandbox } from "../platform/try-sandbox-seed.js";
import { provisionOrgForUser } from "./auth.js";

export type StartedSandbox =
  | { ok: true; sandbox: SandboxResult; live: number; max: number }
  | { ok: false; live: number; max: number };

/** A sandbox, handed over, or `ok: false` when the box is at its cap. `quiet`
 *  is an operator's: nothing is announced, because nobody arrived.
 *  `waitForCovers` holds the answer until a freshly built sandbox's pictures
 *  have landed: a process that exits next (the operator's CLI) would otherwise
 *  cut them off. The public door does not wait; the visitor arrives first. */
export async function startSandbox(opts: { quiet?: boolean; waitForCovers?: boolean } = {}): Promise<StartedSandbox> {
  // The population cap. Rate limits bound arrivals; only this bounds how many
  // Postgres databases exist at once, which is the thing that actually falls
  // over. Answering "busy" is the correct behaviour, not an error.
  const cap = await sandboxCapacity();
  if (!cap.ok) return { ok: false, live: cap.live, max: cap.max };

  // A ready-made one if the pool has any: instant, and its book covers are
  // already in place rather than filling in while somebody watches.
  const pooled = await takeFromPool(Date.now(), { quiet: opts.quiet });
  if (pooled) {
    console.log(`[try-sandbox] handed over ${pooled.slug} from the pool`);
    return { ok: true, sandbox: pooled, live: cap.live, max: cap.max };
  }
  const ws = await provisionSandboxWorkspace({
    provisionOrg: async (userId, name) => {
      const r = await provisionOrgForUser(userId, name);
      return { orgId: r.orgId, slug: r.slug };
    },
    enableDefaults: (orgId, userId) => enableDefaultModulesForOrg(orgId, userId),
  });
  // An empty workspace is a poor first impression - the lesson the demo
  // taught. Best-effort: a seed that fails leaves a usable empty sandbox
  // rather than no sandbox. Seeded BEFORE the hand-over, as the pool
  // does, so the stock sits on the platform's side of the ledger's
  // starting line on both paths (trial-ledger.ts).
  try {
    const seed = await seedSandbox(ws.orgId, ws.userId, env.TRY_SANDBOX_SEED, ws.slug);
    // Say what landed, not that it ran. "seeded" with nothing in it is the
    // empty table this seed exists to prevent, and it should be legible in
    // the log the first time it happens rather than found by a visitor.
    const r = seed.contents;
    console.log(
      `[try-sandbox] seed ${seed.seeded ? seed.name : `skipped (${seed.reason})`}` +
        (r ? `: ${r.created} records${r.failed ? `, ${r.failed} FAILED` : ""}` : ""),
    );
    // Covers are still arriving; say so when they have, rather than holding
    // the visitor at a loading page for them.
    const covers = r?.images.then((n) => console.log(`[try-sandbox] covers landed: ${n}`));
    if (opts.waitForCovers) await covers?.catch((err: unknown) => console.error("[try-sandbox] covers failed:", (err as Error).message));
    // DETACHED: a log line when the covers land; the sandbox is handed over without them
    else void covers;
  } catch (err) {
    console.error("[try-sandbox] seed failed (continuing empty):", (err as Error).message);
  }
  return { ok: true, sandbox: await handOverSandbox(ws, Date.now(), { quiet: opts.quiet }), live: cap.live, max: cap.max };
}
