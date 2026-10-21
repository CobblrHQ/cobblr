// Every move of a place under another goes through here: the page's form, the
// assistant's writer, Move everything, a layout's Apply and their undos.
//
// A move into a place that is inside the one moving makes a loop, and a place
// in a loop never reaches the top of the tree, so the tree draws neither it
// nor anything in it. Checking first and writing after is not enough: two
// people moving Garage into Attic and Attic into Garage at the same moment
// each find no loop, and both writes land. So a move holds the workspace's
// tree lock from its check to its last depth.
import { sql, type Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";

type Db = Kysely<CoreLocationsDB>;

export class PlaceMoveRefused extends Error {
  readonly code: "cycle" | "invalid_parent";
  constructor(code: "cycle" | "invalid_parent", message: string) {
    super(message);
    this.code = code;
  }
}

/** Take the tree lock for the rest of `trx`. Tenant databases are one per
 *  workspace, and an advisory lock is per database, so this is per workspace. */
export async function lockTree(trx: Db): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('core_locations_locations.parent_id'))`.execute(trx);
}

/** Put `id` under `parentId` (the top when null) and re-depth everything
 *  inside it, refusing a move that would make a loop. */
export async function movePlace(db: Db, id: string, parentId: string | null): Promise<void> {
  if (parentId === id) throw new PlaceMoveRefused("cycle", "A place cannot go inside itself.");
  await db.transaction().execute(async (trx) => {
    await lockTree(trx);
    let depth = 0;
    if (parentId) {
      const seen = new Set<string>();
      for (let cur: string | null = parentId; cur && !seen.has(cur); ) {
        if (cur === id) throw new PlaceMoveRefused("cycle", "A place cannot go inside a place that is inside it.");
        seen.add(cur);
        const row: { parent_id: string | null } | undefined = await trx
          .selectFrom("core_locations_locations")
          .select("parent_id")
          .where("id", "=", cur)
          .executeTakeFirst();
        if (!row) throw new PlaceMoveRefused("invalid_parent", "parent_id not found");
        cur = row.parent_id;
      }
      depth = (await trx.selectFrom("core_locations_locations").select("depth").where("id", "=", parentId).executeTakeFirstOrThrow()).depth + 1;
    }
    await trx
      .updateTable("core_locations_locations")
      .set({ parent_id: parentId, depth, updated_at: new Date() } as never)
      .where("id", "=", id)
      .execute();
    await rebuildDescendantDepths(trx, id);
  });
}

/** Rewrite the depth of everything inside `rootId` after it moved. Iterative,
 *  and it visits each place once, so a loop already in the data ends the walk
 *  instead of spinning a request forever. */
export async function rebuildDescendantDepths(db: Db, rootId: string): Promise<void> {
  const root = await db.selectFrom("core_locations_locations").select("depth").where("id", "=", rootId).executeTakeFirst();
  if (!root) return;
  const seen = new Set<string>([rootId]);
  let frontier: Array<{ id: string; depth: number }> = [{ id: rootId, depth: root.depth }];
  while (frontier.length > 0) {
    const depthOf = new Map(frontier.map((f) => [f.id, f.depth]));
    const children = await db
      .selectFrom("core_locations_locations")
      .select(["id", "parent_id"])
      .where("parent_id", "in", [...depthOf.keys()])
      .execute();
    const next: Array<{ id: string; depth: number }> = [];
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const childDepth = depthOf.get(c.parent_id!)! + 1;
      await db.updateTable("core_locations_locations").set({ depth: childDepth }).where("id", "=", c.id).execute();
      next.push({ id: c.id, depth: childDepth });
    }
    frontier = next;
  }
}

/** The places that do not reach the top of the tree: none when the tree
 *  holds. A write that re-parents many places at once (an import) asks this
 *  before it commits. */
export async function placesOffTheTree(db: Db): Promise<Array<{ id: string; name: string }>> {
  const rows = await sql<{ id: string; name: string }>`
    with recursive tree as (
      select id from core_locations_locations where parent_id is null
      union
      select c.id from core_locations_locations c join tree t on c.parent_id = t.id
    )
    select id, name from core_locations_locations where id not in (select id from tree) order by name
  `.execute(db);
  return rows.rows;
}
