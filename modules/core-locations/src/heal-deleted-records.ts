// DONE WHEN: core_locations_deleted is empty in every workspace.
// BORN WITH: deletePlace keeps every new deletion in platform.deletedRecords.
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { CoreLocationsDB } from "./db.js";

export function registerDeletedPlacesHeal(): void {
  registerHealPass({ name: "core-locations.deleted-records", shim: "modules/core-locations/src/heal-deleted-records.ts", module: "core-locations", visit: async ({ orgId, db }) => {
    const own = db as Kysely<CoreLocationsDB>;
    const rows = await own.selectFrom("core_locations_deleted").selectAll().execute();
    for (const kept of rows) {
      const rows = (typeof kept.rows === "string" ? JSON.parse(kept.rows) : kept.rows) as Record<string, unknown>[];
      const root = rows.find((r) => r.id === kept.id);
      if (root && !await platform().deletedRecords.get(orgId, "core-locations:location", kept.id)) await platform().deletedRecords.keep(orgId, "core-locations:location", kept.id, root,
        { name: kept.name, rows, placements: kept.placements }, kept.deleted_by, new Date(kept.deleted_at));
      await own.deleteFrom("core_locations_deleted").where("id", "=", kept.id).execute();
    }
    return rows.length;
  } });
}
