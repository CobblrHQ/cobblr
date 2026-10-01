// A place inside a place is nested by parent_id, not by placement, so the
// platform's "where is this" (placement.pathsOf) asks this module for a
// place's parent. With it, a thing in a Backpack that sits in a Desk drawer
// reads "Backpack, in Desk drawer, in Office", not just "Backpack, in Desk drawer".
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";

export const LOCATION_KIND = "core-locations:location";

export function registerPlaceParent(): void {
  platform().placement.registerParent(LOCATION_KIND, async (orgId, id) => {
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreLocationsDB>;
    const row = await db.selectFrom("core_locations_locations").select("parent_id").where("id", "=", id).executeTakeFirst();
    return row?.parent_id ? { kind: LOCATION_KIND, id: row.parent_id } : null;
  });
}
