// A workspace behind this api's migrations is caught up without waiting for
// the next boot (#8724). The boot sync runs once, before this api serves; in
// a blue-green roll the older api keeps serving while this one boots, so a
// workspace it makes then (or a module it enables then) carries the older
// migrations only. On staging that left one walk workspace on core-import's
// first migration and the roll refusing the new api as unhealthy.
// PERMANENT RECONCILE: every roll runs two apis side by side.
// BORN WITH: enableModuleForOrg (a fresh enable applies every migration this api carries).
import { platform } from "@cobblr/platform-contract";
import { behindModulesByOrg, catchUpOrgMigrations } from "../modules/enable.js";

export const CATCH_UP_PASS = "platform.tenant-migrations-catch-up";

export function registerTenantMigrationsCatchUp(): void {
  platform().sweeps.register({
    name: CATCH_UP_PASS,
    everyMs: 5 * 60 * 1000,
    // The older api is stopped a minute or so after this one serves: the
    // first round comes after it, so what it made last is caught.
    firstAfterMs: 90_000,
    // Meta-side only: a settled instance opens no tenant pool.
    candidates: async (orgIds) => [...(await behindModulesByOrg(orgIds)).keys()],
    visit: async ({ orgId }) => ({ applied: await catchUpOrgMigrations(orgId) }),
  });
}

let lastPoke = 0;

/** /healthz found a workspace behind: run the pass for it now, not at the
 *  next round, so a roll re-reading health sees it settle. At most every 30 s. */
export async function catchUpBehindSoon(now = Date.now()): Promise<void> {
  if (now - lastPoke < 30_000) return;
  lastPoke = now;
  for (const orgId of (await behindModulesByOrg()).keys()) platform().sweeps.soon(CATCH_UP_PASS, orgId);
}
