// A one-shot heal is a registered sweep pass, not a private walk.
//
// A module's boot heal used to walk every workspace itself, from onBoot, at
// the same moment as every other module's boot work. Each opened and released
// one pool at a time and was correct alone; together, on staging (340
// workspaces with core-scan), core-scan's two heals failed 339 and 340
// workspaces on "remaining connection slots are reserved for roles with the
// SUPERUSER attribute", so the heal-filed-into shim had never healed anything
// there and the unconfirmed-identifier heal (#3647) reached one workspace of
// 341. The kernel's sweep scheduler (api/src/platform/tenant-sweeps.ts)
// already has the answer for periodic passes: one walk, one connection
// budget, a boot stagger, a workspace whose pool cannot open retried after a
// short wait. This puts a heal on it.
//
// A workspace a visit finds nothing to heal in is not opened again for the
// life of the process, so after the first clean round a heal costs nothing.
// The shim's count reaches /healthz (noteHealShim) the moment the round has
// visited every workspace it meant to. A round with a workspace whose pool
// never opened is reported when the next round starts, that workspace as a
// failure. (Reporting only then lost every report on staging, which restarts
// more often than a round's cadence.)

import { platform } from "@cobblr/platform-contract";

/** How often a heal looks again at the workspaces it has not seen clean. */
export const HEAL_EVERY_MS = 30 * 60_000;
/** The first round, after the boot's own work has settled. */
export const HEAL_FIRST_AFTER_MS = 2 * 60_000;

export interface HealVisit {
  orgId: string;
  /** The workspace's db, open for this visit (cast to the module's schema). */
  db: unknown;
}

export interface HealPass {
  /** `<module>.heal-<what>`: unique, and the pass's advisory-lock name. */
  name: string;
  /** The shim's path, as /healthz reports it and its DONE WHEN names it. */
  shim: string;
  /** Only workspaces with this module enabled. */
  module?: string;
  /** Heal one workspace; answer how many rows needed it (0 = clean). A
   *  visit that found rows it cannot heal answers `{ found, settled: true }`:
   *  they still count toward the shim's DONE WHEN, and the workspace is not
   *  reopened every round for rows nothing can change. */
  visit: (v: HealVisit) => Promise<number | { found: number; settled: boolean }>;
}

export function registerHealPass(pass: HealPass): void {
  /** Workspaces not reopened, with the rows each still holds that no visit
   *  can heal: carried into every report, so a skipped workspace never reads
   *  as a clean one. */
  const settled = new Map<string, number>();
  const residue = () => [...settled.values()].reduce((a, b) => a + b, 0);
  // A workspace the round meant to visit and never reached (its pool would
  // not open) is a failure, not a clean workspace.
  let round: { found: number; failed: number; todo: number; reached: number } | null = null;
  const report = () => {
    if (round) void platform().health.noteHealShim(pass.shim, round.found + residue(), round.failed + (round.todo - round.reached));
    round = null;
  };
  platform().sweeps.register({
    name: pass.name,
    everyMs: HEAL_EVERY_MS,
    firstAfterMs: HEAL_FIRST_AFTER_MS,
    ...(pass.module ? { module: pass.module } : {}),
    candidates: async (orgIds) => {
      report();
      const todo = orgIds.filter((id) => !settled.has(id));
      if (!todo.length) {
        void platform().health.noteHealShim(pass.shim, residue(), 0);
        return [];
      }
      round = { found: 0, failed: 0, todo: todo.length, reached: 0 };
      return todo;
    },
    visit: async ({ orgId, db }) => {
      const mine = round;
      try {
        const out = await pass.visit({ orgId, db });
        const found = typeof out === "number" ? out : out.found;
        if (found === 0) settled.set(orgId, 0);
        else if (typeof out === "object" && out.settled) settled.set(orgId, found);
        else if (mine) mine.found += found;
        return { found };
      } catch (err) {
        if (mine) mine.failed++;
        throw err;
      } finally {
        // The round's last visit reports it; a later round's gate would
        // otherwise be the only door, and a restart closes that one.
        if (mine && ++mine.reached === mine.todo && round === mine) report();
      }
    },
  });
}
