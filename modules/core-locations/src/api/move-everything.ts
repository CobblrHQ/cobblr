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
//
// The destination may also be a thing that holds things (a Backpack, a
// toolbox): the things go inside it. Places cannot, so a move that would take
// the places along into one is refused, and the holder itself stays put if it
// was kept in the place being emptied.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreLocationsDB } from "../db.js";
import { deletePlace, restoreDeletedPlace } from "./place-delete.js";
import { movePlace, PlaceMoveRefused } from "./place-move.js";

const LOCATION = "core-locations:location";
type Db = Kysely<CoreLocationsDB>;

export interface MovedThing {
  kind: string;
  id: string;
  slot: string | null;
  position: unknown;
}

/** Where a move went: a place, or a thing that holds things (kind set). */
export interface MoveTarget {
  id: string;
  name: string;
  kind?: string;
}

/** What a move did: enough to undo it, and to say it. */
export interface MoveResult {
  from: { id: string; name: string };
  to: MoveTarget;
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
  try {
    await movePlace(db, id, parentId);
  } catch (e) {
    if (e instanceof PlaceMoveRefused) throw new MoveRefused(e.message);
    throw e;
  }
}

type MoveOpts = { places?: boolean; thenDelete?: boolean; userId?: string | null };

/** Everything a move will touch, or why it cannot happen. The move and its
 *  confirm card read it the same way, so the card lists what the move does. */
async function readMove(db: Db, orgId: string, fromId: string, toRef: string | { kind: string; id: string }, opts: MoveOpts) {
  const places = !!(opts.places || opts.thenDelete);
  const holder = typeof toRef === "object" && toRef.kind !== LOCATION ? toRef : null;
  const toId = typeof toRef === "object" ? toRef.id : toRef;
  if (!holder && fromId === toId) throw new MoveRefused("That is the same place.");
  const rows = await db
    .selectFrom("core_locations_locations")
    .select(["id", "name"])
    .where("id", "in", holder ? [fromId] : [fromId, toId])
    .execute();
  const from = rows.find((r) => r.id === fromId);
  if (!from) throw new MoveRefused("That place is not there any more.");
  let to: MoveTarget | undefined;
  if (holder) {
    const found = (await platform().entities.lookupMany(orgId, [holder], { system: true }).catch(() => []))[0];
    to = found ? { kind: holder.kind, id: holder.id, name: found.title } : undefined;
  } else {
    to = rows.find((r) => r.id === toId);
  }
  if (!to) throw new MoveRefused("The place to move them to is not there any more.");
  const children = places
    ? await db.selectFrom("core_locations_locations").select("id").where("parent_id", "=", fromId).execute()
    : [];
  if (holder && children.length) {
    throw new MoveRefused(`${to.name} is not a place, so the places in ${from.name} cannot move into it.`);
  }
  if (!holder && places && (await isInside(db, toId, fromId))) {
    throw new MoveRefused(`${to.name} is inside ${from.name}, so the places in ${from.name} cannot move into it.`);
  }
  const container = holder ?? { kind: LOCATION, id: toId };
  const contents = await platform().placement.contents({ orgId, container: { kind: LOCATION, id: fromId } });
  const holderStaysBehind = !!holder && contents.some((t) => t.kind === holder.kind && t.id === holder.id);
  if (holderStaysBehind && opts.thenDelete) {
    throw new MoveRefused(`${to.name} is kept in ${from.name}, so ${from.name} cannot be emptied into it and deleted.`);
  }
  const moving = contents.filter((t) => t.kind !== LOCATION && !(holder && t.kind === holder.kind && t.id === holder.id));
  return { from, to, toId, holder, container, children, moving };
}

/** Move what is kept in `fromId` into `toId` (a place's id, or a holder's
 *  `{kind, id}`); with `places`, the places inside it too; with `thenDelete`,
 *  then delete the empty place (a merge, which always takes the places). */
export async function moveEverything(
  orgId: string,
  fromId: string,
  toRef: string | { kind: string; id: string },
  opts: MoveOpts,
): Promise<MoveResult> {
  const db = await dbOf(orgId);
  const { from, to, toId, holder, container, children, moving } = await readMove(db, orgId, fromId, toRef, opts);

  if (holder) {
    const path = (await platform().placement.pathsOf({ orgId, containees: [holder] })).get(`${holder.kind}:${holder.id}`) ?? [];
    const movingKeys = new Set(moving.map((t) => `${t.kind}:${t.id}`));
    const ancestor = path.find((step) => movingKeys.has(`${step.kind}:${step.id}`));
    if (ancestor) {
      throw new MoveRefused(`${to.name} is inside ${ancestor.name}, so ${ancestor.name} cannot move into it. Nothing has moved.`);
    }
  }

  const things: MovedThing[] = [];
  for (const t of moving) {
    await platform().placement.place({
      orgId,
      containee: { kind: t.kind, id: t.id },
      container,
      placedBy: opts.userId ?? null,
      via: "Move everything",
      preserveIdentity: true,
    });
    things.push({ kind: t.kind, id: t.id, slot: t.slot ?? null, position: t.position ?? null });
  }

  const moved: string[] = [];
  for (const k of children) {
    await reparent(db, k.id, toId);
    moved.push(k.id);
  }

  let deleted = false;
  if (opts.thenDelete) deleted = !!(await deletePlace(orgId, fromId, opts.userId ?? null, { kind: to.kind ?? LOCATION, id: to.id, name: to.name }));

  if (!holder) void platform().events.emit("core-locations.location.updated", { orgId, locationId: toId });
  if (!deleted) void platform().events.emit("core-locations.location.updated", { orgId, locationId: fromId });
  return { from: { id: from.id, name: from.name }, to, things, places: moved, deleted };
}

/** What a move will do, before it does it: the place being emptied stays
 *  where it is, and only what is inside it goes. Asked to move a shelf "with
 *  its bins", an assistant chose this and the shelf stayed behind while its
 *  bins left it (#8050); the card is where a person catches that. */
export async function planMove(
  orgId: string,
  fromId: string,
  toRef: string | { kind: string; id: string },
  opts: MoveOpts,
): Promise<{ title: string; lines: string[] }> {
  const db = await dbOf(orgId);
  const { from, to, children, moving } = await readMove(db, orgId, fromId, toRef, opts);
  const parent = await db
    .selectFrom("core_locations_locations as l")
    .leftJoin("core_locations_locations as p", "p.id", "l.parent_id")
    .select("p.name as name")
    .where("l.id", "=", fromId)
    .executeTakeFirst();
  const places = children.length
    ? await db.selectFrom("core_locations_locations").select("name").where("id", "in", children.map((c) => c.id)).orderBy("name").execute()
    : [];
  const titles = moving.length ? await platform().entities.lookupMany(orgId, moving.map((t) => ({ kind: t.kind, id: t.id })), { system: true }).catch(() => []) : [];
  const stays = parent?.name ? `${from.name} itself stays in ${parent.name}` : `${from.name} itself stays where it is`;
  const title = opts.thenDelete
    ? `Move everything in ${from.name} into ${to.name}, then delete ${from.name}`
    : `Move what is in ${from.name} into ${to.name}; ${stays}`;
  const lines = [
    ...places.map((p) => `${p.name} (a place, with what is in it) into ${to.name}`),
    ...moving.map((t) => `${titles.find((x) => x.id === t.id)?.title ?? "a thing"} into ${to.name}`),
  ];
  return { title, lines: lines.length ? lines : [`${from.name} has nothing in it to move.`] };
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
  let leftWhereTheyAre = 0;
  for (const id of move.places) {
    const row = await db.selectFrom("core_locations_locations").select("parent_id").where("id", "=", id).executeTakeFirst();
    if (row?.parent_id !== move.to.id) {
      leftWhereTheyAre++;
      continue;
    }
    await reparent(db, id, move.from.id);
    places++;
  }
  let things = 0;
  for (const t of move.things) {
    const now = await platform().placement.containerOf({ orgId, containee: { kind: t.kind, id: t.id } }).catch(() => null);
    if (!now || now.kind !== (move.to.kind ?? LOCATION) || now.id !== move.to.id) {
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
      preserveIdentity: true,
    });
    things++;
  }
  void platform().events.emit("core-locations.location.updated", { orgId, locationId: move.from.id });
  if (!move.to.kind || move.to.kind === LOCATION) void platform().events.emit("core-locations.location.updated", { orgId, locationId: move.to.id });
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
    to: { id: m.to.id, name: m.to.name, ...(typeof (m.to as MoveTarget).kind === "string" ? { kind: (m.to as MoveTarget).kind } : {}) },
    things: things.map((t) => ({ kind: t.kind, id: t.id, slot: typeof t.slot === "string" ? t.slot : null, position: t.position ?? null })),
    places,
    deleted: m.deleted === true,
  };
}
