// Emptying one place into another, and putting it back.
//
// Clearing out a bin meant moving each thing in it by hand, and merging two
// places that turned out to be one (two "Bin 3"s from two imports) meant that
// and then deleting one of them (#4191). Here the things kept in a place move
// through the placement seam, each an activity row on the thing, the places
// inside it move under the new parent with their own contents, and a merge
// is exactly that followed by deleting the now-empty place, under the
// delete's own rules (place-delete.ts).
//
// What moved is returned in full, so putting it back is a function of the
// result: every thing to the place and slot it had, every place to its old
// parent, and a merged-away place restored first. A thing someone has moved
// again since stays where they put it.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";
import { deletePlace, restoreDeletedPlace } from "./place-delete.js";
import { rebuildDescendantDepths } from "./locations.js";

const LOCATION = "core-locations:location";
type Db = Kysely<CoreLocationsDB>;

export interface MovedThing {
  kind: string;
  id: string;
  slot: string | null;
  position: unknown;
}

/** What a move did: enough to undo it, and to say it. */
export interface MoveResult {
  from: { id: string; name: string };
  to: { id: string; name: string };
  things: MovedThing[];
  places: string[];
  deleted: boolean;
}

export class MoveRefused extends Error {}

async function dbOf(orgId: string): Promise<Db> {
  return (await platform().tenants.getDb(orgId)) as unknown as Db;
}

async function isInside(db: Db, id: string, ancestor: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let cur: string | null = id; cur && !seen.has(cur); ) {
    if (cur === ancestor) return true;
    seen.add(cur);
    const row: { parent_id: string | null } | undefined = await db
      .selectFrom("core_locations_locations")
      .select("parent_id")
      .where("id", "=", cur)
      .executeTakeFirst();
    cur = row?.parent_id ?? null;
  }
  return false;
}

async function reparent(db: Db, id: string, parentId: string | null): Promise<void> {
  const parent = parentId
    ? await db.selectFrom("core_locations_locations").select("depth").where("id", "=", parentId).executeTakeFirst()
    : null;
  await db
    .updateTable("core_locations_locations")
    .set({ parent_id: parentId, depth: parent ? parent.depth + 1 : 0, updated_at: new Date() } as never)
    .where("id", "=", id)
    .execute();
  await rebuildDescendantDepths(db, id);
}

/** Move what is kept in `fromId` into `toId`; with `places`, the places inside
 *  it too; with `thenDelete`, then delete the empty place (a merge, which
 *  always takes the places). */
export async function moveEverything(
  orgId: string,
  fromId: string,
  toId: string,
  opts: { places?: boolean; thenDelete?: boolean; userId?: string | null },
): Promise<MoveResult> {
  const db = await dbOf(orgId);
  const places = !!(opts.places || opts.thenDelete);
  if (fromId === toId) throw new MoveRefused("That is the same place.");
  const rows = await db.selectFrom("core_locations_locations").select(["id", "name"]).where("id", "in", [fromId, toId]).execute();
  const from = rows.find((r) => r.id === fromId);
  const to = rows.find((r) => r.id === toId);
  if (!from) throw new MoveRefused("That place is not there any more.");
  if (!to) throw new MoveRefused("The place to move them to is not there any more.");
  if (places && (await isInside(db, toId, fromId))) {
    throw new MoveRefused(`${to.name} is inside ${from.name}, so the places in ${from.name} cannot move into it.`);
  }

  const things: MovedThing[] = [];
  const inside = await platform().placement.contents({ orgId, container: { kind: LOCATION, id: fromId } });
  for (const t of inside) {
    if (t.kind === LOCATION) continue;
    await platform().placement.place({
      orgId,
      containee: { kind: t.kind, id: t.id },
      container: { kind: LOCATION, id: toId },
      placedBy: opts.userId ?? null,
      via: "Move everything",
    });
    things.push({ kind: t.kind, id: t.id, slot: t.slot ?? null, position: t.position ?? null });
  }

  const moved: string[] = [];
  if (places) {
    const kids = await db.selectFrom("core_locations_locations").select("id").where("parent_id", "=", fromId).execute();
    for (const k of kids) {
      await reparent(db, k.id, toId);
      moved.push(k.id);
    }
  }

  let deleted = false;
  if (opts.thenDelete) deleted = !!(await deletePlace(orgId, fromId, opts.userId ?? null));

  void platform().events.emit("core-locations.location.updated", { orgId, locationId: toId });
  if (!deleted) void platform().events.emit("core-locations.location.updated", { orgId, locationId: fromId });
  return { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name }, things, places: moved, deleted };
}

/** Put a move back: the place first if it was merged away, then each place
 *  and each thing that is still where the move left it. */
export async function putBackEverything(
  orgId: string,
  move: MoveResult,
  userId?: string | null,
): Promise<{ things: number; places: number; leftWhereTheyAre: number }> {
  const db = await dbOf(orgId);
  if (move.deleted && !(await restoreDeletedPlace(orgId, move.from.id))) {
    throw new MoveRefused(`${move.from.name} cannot be put back any more.`);
  }
  let places = 0;
  for (const id of move.places) {
    const row = await db.selectFrom("core_locations_locations").select("parent_id").where("id", "=", id).executeTakeFirst();
    if (row?.parent_id !== move.to.id) continue;
    await reparent(db, id, move.from.id);
    places++;
  }
  let things = 0;
  let leftWhereTheyAre = 0;
  for (const t of move.things) {
    const now = await platform().placement.containerOf({ orgId, containee: { kind: t.kind, id: t.id } }).catch(() => null);
    if (!now || now.kind !== LOCATION || now.id !== move.to.id) {
      leftWhereTheyAre++;
      continue;
    }
    await platform().placement.place({
      orgId,
      containee: { kind: t.kind, id: t.id },
      container: { kind: LOCATION, id: move.from.id },
      slot: t.slot,
      ...(t.position ? { position: t.position as never } : {}),
      placedBy: userId ?? null,
      via: "Undo",
    });
    things++;
  }
  void platform().events.emit("core-locations.location.updated", { orgId, locationId: move.from.id });
  void platform().events.emit("core-locations.location.updated", { orgId, locationId: move.to.id });
  return { things, places, leftWhereTheyAre };
}

/** A move result as sent back by a client or an action's stored result: the
 *  shape, checked, before anything is written from it. */
export function readMoveResult(v: unknown): MoveResult | null {
  const m = v as Partial<MoveResult> | null;
  const isRef = (r: unknown): r is { id: string; name: string } =>
    !!r && typeof (r as { id?: unknown }).id === "string" && typeof (r as { name?: unknown }).name === "string";
  if (!m || !isRef(m.from) || !isRef(m.to) || !Array.isArray(m.things) || !Array.isArray(m.places)) return null;
  const things = m.things.filter(
    (t): t is MovedThing => !!t && typeof (t as MovedThing).kind === "string" && typeof (t as MovedThing).id === "string",
  );
  const places = m.places.filter((p): p is string => typeof p === "string");
  return {
    from: { id: m.from.id, name: m.from.name },
    to: { id: m.to.id, name: m.to.name },
    things: things.map((t) => ({ kind: t.kind, id: t.id, slot: typeof t.slot === "string" ? t.slot : null, position: t.position ?? null })),
    places,
    deleted: m.deleted === true,
  };
}
