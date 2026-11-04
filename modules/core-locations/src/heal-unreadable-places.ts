// One-shot heal: a write through the API or the assistant could store a floor
// plan whose walls are not walls, and the room's page and plan page showed only
// the error screen, with nothing to press. It could also name a place with
// spaces or invisible characters, which drew a row with nothing on it. What
// can be drawn stays, and a place with no readable name gets one.
//
// DONE WHEN: no core_locations_locations row has walls drawableWalls would
// drop, or a name hasSomethingToRead refuses. Check prod, staging and dev, then
// delete this file and its registration in api/index.ts.
//
// BORN WITH: the route and the writer refuse both (planProblem in
// plan-clearance.ts, hasSomethingToRead in api/util.ts).

import { sql, type Kysely } from "kysely";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { drawableWalls } from "@cobblr/platform-contract/plan-clearance";
import type { CoreLocationsDB } from "./db.js";
import { hasSomethingToRead } from "./api/util.js";

export const NO_NAME = "Unnamed place";

export async function healUnreadablePlaces(db: Kysely<CoreLocationsDB>, since: Date): Promise<number> {
  const rows = await sql<{ id: string; name: string; walls: unknown }>`
    select id, name, metadata->'floorplan'->'walls' as walls from core_locations_locations
    where created_at < ${since} and (jsonb_typeof(metadata->'floorplan'->'walls') is not null or name !~ '[[:alnum:]]')
  `.execute(db);
  let healed = 0;
  for (const r of rows.rows) {
    const kept = r.walls === null || r.walls === undefined ? null : drawableWalls(r.walls);
    const wallsBad = kept !== null && (!Array.isArray(r.walls) || kept.length !== r.walls.length);
    const nameBad = !hasSomethingToRead(r.name);
    if (!wallsBad && !nameBad) continue;
    await sql`
      update core_locations_locations set
        name = ${nameBad ? NO_NAME : r.name},
        metadata = case when ${wallsBad} then jsonb_set(metadata, '{floorplan,walls}', ${JSON.stringify(kept ?? [])}::jsonb) else metadata end
      where id = ${r.id}
    `.execute(db);
    healed++;
  }
  return healed;
}

export function registerUnreadablePlacesHeal(): void {
  registerHealPass({
    name: "core-locations.unreadable-places",
    since: "2026-11-04T17:16:00Z",
    shim: "modules/core-locations/src/heal-unreadable-places.ts",
    module: "core-locations",
    visit: ({ db, since }) => healUnreadablePlaces(db as Kysely<CoreLocationsDB>, since),
  });
}
