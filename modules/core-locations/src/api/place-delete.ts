// Deleting a place, and putting it back.
//
// A delete cascades down the tree (parent_id on delete cascade), and nothing
// in the database knows what was kept in those places: a thing's place is a
// placement row plus the legacy location_id, and neither has a foreign key to
// the location. So a delete takes everything out through the placement seam
// first (the same door a person's own "take it out" uses), or every thing
// kept there would go on pointing at a place that no longer exists (#4115).
//
// Before any of that, it writes down what is about to go: every place in the
// subtree, whole rows with their ids, and where each thing inside them was.
// Undo puts that back: the same ids, so labels, links and the floor plan all
// find their places again, and each thing back where it was unless someone
// has put it somewhere else since. Every door reaches the same undo: the
// page's Undo button, and the assistant's, which restores the one row it knew
// about through the writer and so finds this record by that row's id.
import { platform, restoreRowTree } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";

const LOCATION = "core-locations:location";
const TABLE = "core_locations_locations";

type Db = Kysely<CoreLocationsDB>;

interface KeptPlacement {
  containee: { kind: string; id: string };
  container: string;
  slot: string | null;
  position: unknown;
}

async function dbOf(orgId: string): Promise<Db> {
  return (await platform().tenants.getDb(orgId)) as unknown as Db;
}

/** The place and every place under it, root first. */
async function withDescendants(db: Db, rootId: string): Promise<string[]> {
  const all = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const children = await db.selectFrom(TABLE).select("id").where("parent_id", "in", frontier).execute();
    frontier = children.map((c) => c.id).filter((id) => !all.includes(id));
    all.push(...frontier);
  }
  return all;
}

async function placementsIn(orgId: string, ids: string[]): Promise<KeptPlacement[]> {
  const out: KeptPlacement[] = [];
  for (const id of ids) {
    const inside = await platform().placement.contents({ orgId, container: { kind: LOCATION, id } });
    for (const c of inside) {
      out.push({ containee: { kind: c.kind, id: c.id }, container: id, slot: c.slot ?? null, position: c.position ?? null });
    }
  }
  return out;
}

/** What deleting this place would take with it: the places inside it (not
 *  counting itself) and the things kept anywhere in there. */
export async function whatGoesWith(orgId: string, rootId: string): Promise<{ places: number; things: number }> {
  const ids = await withDescendants(await dbOf(orgId), rootId);
  const things = (await placementsIn(orgId, ids)).filter((p) => p.containee.kind !== LOCATION).length;
  return { places: ids.length - 1, things };
}

/** Does this place have places inside it? The question that decides whether
 *  a delete is a member's to make. */
export async function hasPlacesInside(orgId: string, rootId: string): Promise<boolean> {
  const db = await dbOf(orgId);
  return !!(await db.selectFrom(TABLE).select("id").where("parent_id", "=", rootId).limit(1).executeTakeFirst());
}

/** Delete a place and everything inside it, keeping what an undo needs.
 *  Null when there is no such place. */
export async function deletePlace(
  orgId: string,
  rootId: string,
  deletedBy: string | null,
): Promise<{ name: string; places: number; things: number } | null> {
  const db = await dbOf(orgId);
  const ids = await withDescendants(db, rootId);
  const rows = (await db.selectFrom(TABLE).selectAll().where("id", "in", ids).orderBy("depth").execute()) as Array<
    Record<string, unknown> & { id: string; name: string }
  >;
  const root = rows.find((r) => r.id === rootId);
  if (!root) return null;
  const placements = await placementsIn(orgId, ids);
  const things = placements.filter((p) => p.containee.kind !== LOCATION);

  await platform().deletedRecords.keep(orgId, LOCATION, rootId, root, { name: root.name, rows, placements }, deletedBy);

  for (const t of things) await platform().placement.remove({ orgId, containee: t.containee });
  await db.deleteFrom(TABLE).where("id", "=", rootId).execute();
  void platform().events.emit("core-locations.location.deleted", { orgId, locationId: rootId });
  return { name: root.name, places: ids.length - 1, things: things.length };
}

/** Put a deleted place back, with every place that went with it and each
 *  thing where it was. Null when this place was not deleted (or was deleted
 *  too long ago to come back). `leftWhereTheyAre` counts things someone has
 *  put somewhere else since: an undo does not take them back out. */
export async function restoreDeletedPlace(
  orgId: string,
  rootId: string,
): Promise<{ name: string; places: number; things: number; leftWhereTheyAre: number } | null> {
  const db = await dbOf(orgId);
  const saved = await platform().deletedRecords.get(orgId, LOCATION, rootId);
  const kept = saved?.details as { name: string; rows: unknown; placements: unknown } | null;
  if (!kept) return null;
  const rows = ((typeof kept.rows === "string" ? JSON.parse(kept.rows) : kept.rows) ?? []) as Array<
    Record<string, unknown> & { id: string; parent_id: string | null; depth: number }
  >;
  const placements = ((typeof kept.placements === "string" ? JSON.parse(kept.placements) : kept.placements) ??
    []) as KeptPlacement[];
  const root = rows.find((r) => r.id === rootId);
  if (!root) return null;

  // The place it was in may have gone since. Then it comes back at the top,
  // with the places inside it keeping their shape under it.
  const parentGone =
    root.parent_id && !(await db.selectFrom(TABLE).select("id").where("id", "=", root.parent_id).executeTakeFirst());
  const shift = parentGone ? root.depth : 0;
  for (const row of [...rows].sort((a, b) => a.depth - b.depth)) {
    const image = { ...row, depth: row.depth - shift, ...(parentGone && row.id === rootId ? { parent_id: null } : {}) };
    await restoreRowTree(db, TABLE, { image }, "core_locations_");
  }

  let things = 0;
  let leftWhereTheyAre = 0;
  for (const p of placements) {
    const now = await platform().placement.containerOf({ orgId, containee: p.containee }).catch(() => null);
    if (now) {
      if (p.containee.kind !== LOCATION) leftWhereTheyAre++;
      continue;
    }
    try {
      await platform().placement.place({
        orgId,
        containee: p.containee,
        container: { kind: LOCATION, id: p.container },
        slot: p.slot,
        ...(p.position ? { position: p.position as never } : {}),
      });
      if (p.containee.kind !== LOCATION) things++;
    } catch {
      // The thing itself was deleted since: nothing to put back.
    }
  }
  await platform().deletedRecords.forget(orgId, LOCATION, rootId);
  void platform().events.emit("core-locations.location.updated", { orgId, locationId: rootId });
  return { name: kept.name, places: rows.length - 1, things, leftWhereTheyAre };
}
