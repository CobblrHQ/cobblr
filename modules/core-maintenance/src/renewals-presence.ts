// The Renewals panel ("Terms") shows where a record has something to renew
// (#6337): a paid term, or a schedule bound to a renewal (an anchor, an
// expiry field, bound renewal fields). A 3D printer or a drill with none
// shows no "No paid terms yet · Add a renewal"; a record whose collection
// has an expiry field does, and a subscription always does
// (its collection is named in the manifest), and so does any record someone
// has added a renewal to.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreMaintenanceDB } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Called once when the module's api loads. */
export function registerRenewalsPresence(): void {
  platform().panels.registerPresence("core-maintenance:renewals", async ({ orgId, kind, id, collection }) => {
    if (!UUID.test(id)) return false;
    // A collection with an expiry field ("Registration expires") renews: the
    // panel's cards are those fields (schedules.ts /renewal-fields).
    const defs = await platform().entities.fieldsFor(orgId, collection ?? kind).catch(() => []);
    if (defs.some((f) => f.type === "date" && f.name.endsWith("_expires"))) return true;
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreMaintenanceDB>;
    const r = await sql<{ n: number }>`
      select 1 as n from core_maintenance_entries where entity_id = ${id} and is_term
      union all
      select 1 from core_maintenance_schedules
       where entity_id = ${id} and (anchor is not null or expiry_field is not null or renewal_fields is not null)
      limit 1`.execute(db);
    return r.rows.length > 0;
  });
}
