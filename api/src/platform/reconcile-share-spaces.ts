// Every share space holds what a share space needs.
//
// BORN WITH: acceptShareInvite (it makes the share space through the same
// shapeShareSpace this pass runs)
//
// PERMANENT RECONCILE. A share space is a workspace of kind 'share'
// (docs/design-decisions/share-spaces.md): its person is an admin, never its
// owner (ending the share is the sharer's). Its modules are a new workspace's
// defaults; anything else turns on the way it does anywhere (a scan routed to
// a module that is off asks for it). A share space whose setup died halfway is
// brought into line on the next boot.
//
// Cost on a settled instance: one cobblr_meta query that returns no rows. It
// opens no tenant pool.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
/** Bring one share space into shape: idempotent, and the one plan both the
 *  accept path and the boot pass run. */
export async function shapeShareSpace(orgId: string): Promise<string[]> {
  const did: string[] = [];
  const demoted = await meta
    .updateTable("org_memberships")
    .set({ role: "admin" })
    .where("org_id", "=", orgId)
    .where("role", "=", "owner")
    .returning("user_id")
    .execute();
  if (demoted.length) did.push(`${demoted.length} owner(s) made admin`);
  return did;
}

export async function reconcileShareSpaces(): Promise<number> {
  const stale = await meta
    .selectFrom("orgs as o")
    .select("o.id")
    .where("o.kind", "=", "share")
    .where((eb) =>
      eb.exists(eb.selectFrom("org_memberships as m").select(sql`1`.as("x")).whereRef("m.org_id", "=", "o.id").where("m.role", "=", "owner")),
    )
    .execute();
  let healed = 0;
  for (const { id } of stale) {
    try {
      const did = await shapeShareSpace(id);
      if (did.length) {
        healed += 1;
        console.log(`[reconcile] share space ${id}: ${did.join(", ")}`);
      }
    } catch (err) {
      console.error(`[reconcile] share space ${id}:`, err);
    }
  }
  return healed;
}
