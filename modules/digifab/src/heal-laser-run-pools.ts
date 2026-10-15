// DONE WHEN: no pool linked to an accepted laser plan lacks config.run_id
// on prod, staging and dev. The update predicate below is the residue check.
// BORN WITH: acceptLockedLaserPlan stamps config.run_id in the run transaction.

import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { DigifabDB } from "./db.js";

export async function healLaserRunPools(db: Kysely<DigifabDB>): Promise<number> {
  const result = await sql`
    update digifab_pools as p
    set config = p.config || jsonb_build_object('run_id', r.id::text)
    from digifab_production_runs as r
    join digifab_laser_plans as l on l.id = r.laser_plan_id and l.run_id = r.id
    where r.pool_id = p.id and p.config ->> 'run_id' is null
  `.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}

export function registerLaserRunPoolsHeal(): void {
  registerHealPass({
    name: "digifab.heal-laser-run-pools",
    shim: "modules/digifab/src/heal-laser-run-pools.ts",
    module: "digifab",
    visit: ({ db }) => healLaserRunPools(db as Kysely<DigifabDB>),
  });
}
