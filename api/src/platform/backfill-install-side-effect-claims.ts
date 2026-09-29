// One-time heal: claim the modules an install switched on before installs
// recorded them (#3918).
// DONE WHEN: this pass finds 0 on prod + staging + dev at boot (every install
// the activity log can attribute has its claims); then delete this file and
// its boot call.
//
// BORN WITH: applyValidatedBundle (an install now claims each module it switches on and each place it creates as it applies)
//
// Until #3918 an install claimed only the modules its own tables live on. The
// modules it switched on because it needed them (Groceries: Lists, Cadence,
// Views) were claimed by nobody, so an uninstall could not tell them from a
// module the person had turned on themselves, and left them on. Where the
// activity log shows the enable, the origin is known: the install's own
// `module_enabled` rows sit in the minutes before its `bundle_installed` activity row, for a
// module its manifest `requires`. Those become the bundle's claims, so its
// uninstall puts them back.
//
// Where the log cannot say, nothing is claimed, and an unclaimed module is
// the person's: never switched off by an uninstall. Places an install made
// before it recorded them are not in the log at all, so they stay the
// person's, the safe reading.
//
// One cobblr_meta query on the happy path; no tenant pool is opened.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { recordClaim } from "./bundle-claims.js";
import { noteHealShim } from "./heal-shim-log.js";

/** How long before an install's row its module enables can sit. An install
 *  enables, migrates and then writes the row; minutes, never hours. */
const WINDOW = "10 minutes";

export async function backfillInstallSideEffectClaims(): Promise<number> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return 0;
  const rows = await sql<{ org_id: string; external_id: string; module_name: string }>`
    select distinct b.org_id, b.external_id, a.entity_id as module_name
    from bundles b
    -- Every time this bundle was installed (an upgrade replaces the bundles
    -- row, so its own timestamp is the LAST install, not the first).
    join activity_log i
      on i.org_id = b.org_id
     and i.action = 'bundle_installed'
     and i.diff ->> 'external_id' = b.external_id
    join activity_log a
      on a.org_id = b.org_id
     and a.action = 'module_enabled'
     and a.entity_type = 'org_module'
     and a.occurred_at between i.occurred_at - interval '${sql.raw(WINDOW)}' and i.occurred_at
    join org_modules om on om.org_id = b.org_id and om.module_name = a.entity_id
    where exists (
        select 1 from jsonb_array_elements(coalesce(b.manifest::jsonb -> 'requires', '[]'::jsonb)) r
        where r ->> 'module' = a.entity_id
      )
      and not exists (
        select 1 from bundle_resource_claims c
        where c.org_id = b.org_id and c.resource_type = 'module' and c.resource_key = a.entity_id
      )
  `.execute(meta);
  let found = 0;
  let failed = 0;
  for (const r of rows.rows) {
    try {
      await recordClaim(r.org_id, r.external_id, "module", r.module_name);
      found++;
      console.log(`[heal] org ${r.org_id}: ${r.external_id} claims ${r.module_name} (switched on at install)`);
    } catch (err) {
      failed++;
      console.error(`[heal] org ${r.org_id}: could not claim ${r.module_name} for ${r.external_id}:`, (err as Error).message);
    }
  }
  await noteHealShim("api/src/platform/backfill-install-side-effect-claims.ts", found, failed);
  return found;
}
