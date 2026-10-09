// A planning layout: what would move where, before anything moves.
//
// Laying out a printer room is trying things: this printer on the bottom
// shelf, that rack against the other wall, a rack that is not bought yet.
// Doing it on the real records moves real things and fills every history
// with the trial. A draft is kept apart (core_locations_plan_drafts): its
// body says which places move (a rack's spot on the floor, a shelf's on the
// rack), where each thing goes, and the racks it plans that do not exist yet.
// Nothing real changes until Apply, which makes the planned racks, moves the
// places and puts every thing where the draft says, through the placement
// seam, as one step: one line in the activity, and what it did kept on the
// draft, so Undo puts each one back. A thing somebody moved again since stays
// where they put it, as Move everything's undo does (move-everything.ts).
//
// A draft holds only what it changes, over the room as it is now, so a
// change made outside it while it is open is not undone by applying it.
// See docs/design-decisions/location-floor-plan.md, "Planning a layout".
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { platform } from "@cobblr/platform-contract";
import { placesUnderDraft, plannedRack } from "@cobblr/platform-contract/plan-draft";
import { isRotation, ownSize, planFlags, readCloset, roomWalls, rotated, type PlanBox, type PlanFlag, type PlanWall } from "@cobblr/platform-contract/plan-clearance";
import { OUTER_SIZE_ROLE, parseOuterSize, type OuterSize } from "@cobblr/platform-contract/outer-size";
import type { Kysely } from "kysely";
import { Router, type Response } from "express";
import { z } from "zod";
import { sessionUser, tenantContext, type CoreLocationsDB } from "../db.js";
import { rebuildDescendantDepths } from "./locations.js";
import { deletePlace } from "./place-delete.js";
import { siblingNamed } from "./siblings.js";
import { asyncHandler, badBody, requireRole } from "./util.js";

const LOCATION = "core-locations:location";
type Db = Kysely<CoreLocationsDB>;

/** A planned place is named in a draft as `planned:<key>`. */
export const PLANNED = "planned:";

const Rect = z.object({
  x_mm: z.number().finite(),
  y_mm: z.number().finite(),
  w_mm: z.number().finite().positive(),
  d_mm: z.number().finite().positive(),
  /** A quarter turn on the plan; w × d are as it stands. */
  rot: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(),
});

export const DraftBody = z.object({
  /** Places that move: a new spot on their parent's plan, or a new parent. */
  moves: z.record(z.string().uuid(), z.object({ parent_id: z.string().optional(), rect: Rect.optional() })).default({}),
  /** Where each thing goes, keyed `<kind>:<id>`: a place's id or a planned
   *  key, and its spot there (on a shelf, x_mm is how far from its left end). */
  things: z
    .record(
      z.string(),
      z.object({
        kind: z.string().min(1),
        id: z.string().min(1),
        into: z.string().min(1),
        x_mm: z.number().finite().optional(),
        y_mm: z.number().finite().optional(),
      }),
    )
    .default({}),
  /** Racks and shelves that do not exist yet. A rack's shelves name it as
   *  their parent (`planned:<its key>`). */
  planned: z
    .array(
      z.object({
        key: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
        name: z.string().trim().min(1).max(200),
        parent: z.string().min(1),
        rect: Rect,
        face: z.object({ w_mm: z.number().positive(), d_mm: z.number().positive() }).optional(),
      }),
    )
    .max(200)
    .default([]),
});
export type DraftBody = z.infer<typeof DraftBody>;

export interface PlanDraft {
  id: string;
  location_id: string;
  name: string;
  body: DraftBody;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

/** What an apply did: enough to undo it, and to say it. */
export interface ApplyResult {
  draft: { id: string; name: string };
  room: { id: string; name: string };
  created: Array<{ key: string; id: string; name: string }>;
  moved: Array<{ id: string; name: string; before: { parent_id: string | null; floorplan: unknown } }>;
  things: Array<{
    kind: string;
    id: string;
    name: string;
    before: { container: { kind: string; id: string } | null; slot: string | null; position: unknown };
    to: { kind: string; id: string };
  }>;
  note: string;
}

export class DraftRefused extends Error {}

async function dbOf(orgId: string): Promise<Db> {
  return (await platform().tenants.getDb(orgId)) as unknown as Db;
}

function readBody(raw: unknown): DraftBody {
  const parsed = DraftBody.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { moves: {}, things: {}, planned: [] };
}

function rowToDraft(r: { id: string; location_id: string; name: string; body: unknown; created_at: Date; updated_at: Date; applied_at: Date | null }): PlanDraft {
  return { id: r.id, location_id: r.location_id, name: r.name, body: readBody(r.body), created_at: r.created_at, updated_at: r.updated_at, applied_at: r.applied_at };
}

export async function listDrafts(orgId: string, locationId: string): Promise<PlanDraft[]> {
  const db = await dbOf(orgId);
  const rows = await db
    .selectFrom("core_locations_plan_drafts")
    .select(["id", "location_id", "name", "body", "created_at", "updated_at", "applied_at"])
    .where("location_id", "=", locationId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map(rowToDraft);
}

export async function getDraft(orgId: string, id: string): Promise<PlanDraft | null> {
  const db = await dbOf(orgId);
  const r = await db
    .selectFrom("core_locations_plan_drafts")
    .select(["id", "location_id", "name", "body", "created_at", "updated_at", "applied_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  return r ? rowToDraft(r) : null;
}

/** The next free "Option A", "Option B"… for a room. */
async function nextName(db: Db, locationId: string): Promise<string> {
  const names = new Set((await db.selectFrom("core_locations_plan_drafts").select("name").where("location_id", "=", locationId).execute()).map((r) => r.name));
  for (let i = 0; i < 26; i++) {
    const n = `Option ${String.fromCharCode(65 + i)}`;
    if (!names.has(n)) return n;
  }
  return `Option ${names.size + 1}`;
}

export async function createDraft(
  orgId: string,
  locationId: string,
  opts: { name?: string | null; body?: unknown; from?: string | null; userId?: string | null },
): Promise<PlanDraft> {
  const db = await dbOf(orgId);
  const room = await db.selectFrom("core_locations_locations").select("id").where("id", "=", locationId).executeTakeFirst();
  if (!room) throw new DraftRefused("That place is not there any more.");
  let body: DraftBody = { moves: {}, things: {}, planned: [] };
  if (opts.from) {
    const src = await getDraft(orgId, opts.from);
    if (!src || src.location_id !== locationId) throw new DraftRefused("There is no such layout to copy.");
    body = src.body;
  } else if (opts.body !== undefined) {
    const parsed = DraftBody.safeParse(opts.body);
    if (!parsed.success) throw new DraftRefused(`That layout does not read: ${parsed.error.issues[0]?.message ?? "bad body"}`);
    body = parsed.data;
  }
  const name = opts.name?.trim() || (await nextName(db, locationId));
  const r = await db
    .insertInto("core_locations_plan_drafts")
    .values({ location_id: locationId, name, body: JSON.stringify(body) as never, created_by: opts.userId ?? null })
    .returning(["id", "location_id", "name", "body", "created_at", "updated_at", "applied_at"])
    .executeTakeFirstOrThrow();
  return rowToDraft(r);
}

export async function updateDraft(orgId: string, id: string, patch: { name?: string; body?: unknown }): Promise<PlanDraft> {
  const db = await dbOf(orgId);
  const cur = await getDraft(orgId, id);
  if (!cur) throw new DraftRefused("There is no such layout.");
  if (cur.applied_at) throw new DraftRefused(`${cur.name} has been applied. Undo it, or copy it, to change it.`);
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) throw new DraftRefused("A layout needs a name.");
    set.name = n;
  }
  if (patch.body !== undefined) {
    const parsed = DraftBody.safeParse(patch.body);
    if (!parsed.success) throw new DraftRefused(`That layout does not read: ${parsed.error.issues[0]?.message ?? "bad body"}`);
    set.body = JSON.stringify(parsed.data);
  }
  await db.updateTable("core_locations_plan_drafts").set(set as never).where("id", "=", id).execute();
  return (await getDraft(orgId, id))!;
}

export async function deleteDraft(orgId: string, id: string): Promise<boolean> {
  const db = await dbOf(orgId);
  const r = await db.deleteFrom("core_locations_plan_drafts").where("id", "=", id).executeTakeFirst();
  return Number(r.numDeletedRows) > 0;
}

async function reparent(db: Db, id: string, parentId: string | null): Promise<void> {
  const parent = parentId ? await db.selectFrom("core_locations_locations").select("depth").where("id", "=", parentId).executeTakeFirst() : null;
  await db
    .updateTable("core_locations_locations")
    .set({ parent_id: parentId, depth: parent ? parent.depth + 1 : 0, updated_at: new Date() } as never)
    .where("id", "=", id)
    .execute();
  await rebuildDescendantDepths(db, id);
}

function floorplanOf(metadata: unknown): Record<string, unknown> {
  const fp = (metadata as { floorplan?: unknown } | null)?.floorplan;
  return fp && typeof fp === "object" ? { ...(fp as Record<string, unknown>) } : {};
}

async function setFloorplan(db: Db, id: string, fp: Record<string, unknown> | null): Promise<void> {
  await db
    .updateTable("core_locations_locations")
    .set({ metadata: platform().db.mergeJsonb("metadata", { floorplan: fp }) as never, updated_at: new Date() } as never)
    .where("id", "=", id)
    .execute();
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Make the draft real, as one step. Refused, with nothing changed, when a
 *  place it names is gone or a planned place's parent cannot be made. */
export async function applyDraft(orgId: string, id: string, userId: string | null): Promise<ApplyResult> {
  const db = await dbOf(orgId);
  const draft = await getDraft(orgId, id);
  if (!draft) throw new DraftRefused("There is no such layout.");
  if (draft.applied_at) throw new DraftRefused(`${draft.name} has already been applied.`);
  const room = await db.selectFrom("core_locations_locations").select(["id", "name"]).where("id", "=", draft.location_id).executeTakeFirst();
  if (!room) throw new DraftRefused("The place this layout is for is not there any more.");
  const body = draft.body;

  // Every real place it names must still be there, before anything moves.
  const planned = new Map(body.planned.map((p) => [p.key, p]));
  const realIds = new Set<string>([
    ...Object.keys(body.moves),
    ...Object.values(body.moves).flatMap((m) => (m.parent_id && !m.parent_id.startsWith(PLANNED) ? [m.parent_id] : [])),
    ...Object.values(body.things).flatMap((t) => (t.into.startsWith(PLANNED) ? [] : [t.into])),
    ...body.planned.flatMap((p) => (p.parent.startsWith(PLANNED) ? [] : [p.parent])),
  ]);
  for (const ref of [...Object.values(body.things).map((t) => t.into), ...body.planned.map((p) => p.parent)]) {
    if (ref.startsWith(PLANNED) && !planned.has(ref.slice(PLANNED.length))) throw new DraftRefused(`The layout names a planned place that is not in it (${ref}).`);
  }
  const rows = realIds.size
    ? await db.selectFrom("core_locations_locations").select(["id", "name", "parent_id", "metadata", "depth"]).where("id", "in", [...realIds]).execute()
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = [...realIds].filter((x) => !byId.has(x));
  if (missing.length) throw new DraftRefused(`${plural(missing.length, "place", "places")} in this layout ${missing.length === 1 ? "is" : "are"} not there any more.`);

  // A planned place takes a name nothing beside it has: two "Rack 2"s in one
  // room are the duplicate a person cannot tell apart, on a label or a scan.
  for (const p of body.planned) {
    if (body.planned.some((q) => q !== p && q.parent === p.parent && q.name.toLowerCase() === p.name.toLowerCase())) {
      throw new DraftRefused(`The layout plans two places called ${p.name} side by side. Rename one.`);
    }
    if (!p.parent.startsWith(PLANNED) && (await siblingNamed(db, p.parent, p.name))) {
      throw new DraftRefused(`There is already a place called ${p.name} there. Rename the planned one.`);
    }
  }

  // Planned places, parents first.
  const created: ApplyResult["created"] = [];
  const made = new Map<string, string>();
  const resolve = (ref: string): string | null => (ref.startsWith(PLANNED) ? (made.get(ref.slice(PLANNED.length)) ?? null) : ref);
  let left = [...body.planned];
  while (left.length) {
    const ready = left.filter((p) => resolve(p.parent) !== null);
    if (!ready.length) throw new DraftRefused("The planned places in this layout name each other as parents in a loop.");
    for (const p of ready) {
      const parentId = resolve(p.parent)!;
      const parent = await db.selectFrom("core_locations_locations").select("depth").where("id", "=", parentId).executeTakeFirst();
      const fp: Record<string, unknown> = { x_mm: Math.round(p.rect.x_mm), y_mm: Math.round(p.rect.y_mm), w_mm: Math.round(p.rect.w_mm), d_mm: Math.round(p.rect.d_mm), ...(p.rect.rot ? { rot: p.rect.rot } : {}) };
      if (p.face) fp.face = { w_mm: Math.round(p.face.w_mm), d_mm: Math.round(p.face.d_mm), view: "front", unit: "mm" };
      const ins = await db
        .insertInto("core_locations_locations")
        .values({ name: p.name, parent_id: parentId, depth: (parent?.depth ?? 0) + 1, kind: "container", metadata: { floorplan: fp } as never })
        .returning(["id", "name"])
        .executeTakeFirstOrThrow();
      made.set(p.key, ins.id);
      created.push({ key: p.key, id: ins.id, name: ins.name });
      await platform().activity.log({
        orgId,
        userId,
        action: "location_created",
        ref: { module: "core-locations", entityType: "location", entityId: ins.id },
        diff: { name: ins.name, parent_id: parentId, via: `layout ${draft.name}` },
      });
    }
    left = left.filter((p) => !made.has(p.key));
  }

  // Places that move.
  const moved: ApplyResult["moved"] = [];
  for (const [locId, m] of Object.entries(body.moves)) {
    const cur = byId.get(locId)!;
    const before = { parent_id: cur.parent_id, floorplan: (cur.metadata as { floorplan?: unknown } | null)?.floorplan ?? null };
    let changed = false;
    if (m.parent_id !== undefined) {
      const to = resolve(m.parent_id);
      if (to && to !== cur.parent_id) {
        await reparent(db, locId, to);
        changed = true;
      }
    }
    if (m.rect) {
      const fp = floorplanOf(cur.metadata);
      const next: Record<string, unknown> = { ...fp, x_mm: Math.round(m.rect.x_mm), y_mm: Math.round(m.rect.y_mm), w_mm: Math.round(m.rect.w_mm), d_mm: Math.round(m.rect.d_mm) };
      // The turn is the draft's to say: none in the draft is none on the rack.
      if (m.rect.rot) next.rot = m.rect.rot;
      else delete next.rot;
      if (["x_mm", "y_mm", "w_mm", "d_mm", "rot"].some((k) => fp[k] !== next[k])) {
        await setFloorplan(db, locId, next);
        changed = true;
      }
    }
    if (changed) moved.push({ id: locId, name: cur.name, before });
  }

  // Things, through the placement seam.
  const things: ApplyResult["things"] = [];
  const names = new Map(
    (await platform().entities.lookupMany(orgId, Object.values(body.things).map((t) => ({ kind: t.kind, id: t.id })), { system: true }).catch(() => [])).map((e) => [`${e.kind}:${e.id}`, e.title]),
  );
  const contentsOf = new Map<string, Awaited<ReturnType<ReturnType<typeof platform>["placement"]["contents"]>>>();
  const contents = async (c: { kind: string; id: string }) => {
    const k = `${c.kind}:${c.id}`;
    if (!contentsOf.has(k)) contentsOf.set(k, await platform().placement.contents({ orgId, container: c }));
    return contentsOf.get(k)!;
  };
  for (const t of Object.values(body.things)) {
    const intoId = resolve(t.into);
    if (!intoId) continue;
    const ref = { kind: t.kind, id: t.id };
    const now = await platform().placement.containerOf({ orgId, containee: ref }).catch(() => null);
    const here = now ? (await contents(now)).find((c) => c.kind === t.kind && c.id === t.id) : undefined;
    const position = t.x_mm !== undefined ? { x_mm: Math.round(t.x_mm), y_mm: Math.round(t.y_mm ?? 0) } : null;
    const same = now && now.kind === LOCATION && now.id === intoId && JSON.stringify(here?.position ?? null) === JSON.stringify(position);
    if (same) continue;
    await platform().placement.place({
      orgId,
      containee: ref,
      container: { kind: LOCATION, id: intoId },
      position,
      placedBy: userId,
      via: `layout ${draft.name}`,
    });
    things.push({
      kind: t.kind,
      id: t.id,
      name: names.get(`${t.kind}:${t.id}`) ?? "a thing",
      before: { container: now, slot: here?.slot ?? null, position: here?.position ?? null },
      to: { kind: LOCATION, id: intoId },
    });
  }

  const what = [
    things.length ? `moved ${plural(things.length, "thing", "things")}` : null,
    moved.length ? `moved ${plural(moved.length, "place", "places")}` : null,
    created.length ? `made ${plural(created.length, "planned place", "planned places")}` : null,
  ].filter(Boolean);
  const note = what.length ? `${draft.name}: ${what.join(", ")}.` : `${draft.name} matched the room already; nothing moved.`;
  const result: ApplyResult = { draft: { id: draft.id, name: draft.name }, room: { id: room.id, name: room.name }, created, moved, things, note: note.charAt(0).toUpperCase() + note.slice(1) };

  await platform().activity.log({
    orgId,
    userId,
    action: "layout_applied",
    ref: { module: "core-locations", entityType: "location", entityId: room.id },
    diff: { layout: draft.name, things: things.length, places: moved.length, made: created.length },
  });
  await db
    .updateTable("core_locations_plan_drafts")
    .set({ applied_at: new Date(), applied: JSON.stringify(result) as never, updated_at: new Date() } as never)
    .where("id", "=", draft.id)
    .execute();
  void platform().events.emit("core-locations.location.updated", { orgId, locationId: room.id });
  return result;
}

/** Undo an apply: each thing still where it put it goes back, each place
 *  back to its spot and parent, and a planned place it made is deleted (its
 *  things already back out). The draft can then be changed and applied again. */
export async function undoApply(
  orgId: string,
  id: string,
  userId: string | null,
): Promise<{ things: number; places: number; deleted: number; leftWhereTheyAre: number; note: string }> {
  const db = await dbOf(orgId);
  const row = await db.selectFrom("core_locations_plan_drafts").select(["id", "name", "applied", "applied_at"]).where("id", "=", id).executeTakeFirst();
  if (!row) throw new DraftRefused("There is no such layout.");
  const applied = row.applied as ApplyResult | null;
  if (!row.applied_at || !applied) throw new DraftRefused(`${row.name} has not been applied.`);
  let things = 0;
  let leftWhereTheyAre = 0;
  for (const t of [...applied.things].reverse()) {
    const ref = { kind: t.kind, id: t.id };
    const now = await platform().placement.containerOf({ orgId, containee: ref }).catch(() => null);
    if (!now || now.kind !== t.to.kind || now.id !== t.to.id) {
      leftWhereTheyAre++;
      continue;
    }
    if (t.before.container) {
      await platform().placement.place({
        orgId,
        containee: ref,
        container: t.before.container,
        slot: t.before.slot,
        position: (t.before.position as never) ?? null,
        placedBy: userId,
        via: "Undo",
      });
    } else {
      await platform().placement.remove({ orgId, containee: ref });
    }
    things++;
  }
  let places = 0;
  for (const m of [...applied.moved].reverse()) {
    const cur = await db.selectFrom("core_locations_locations").select(["parent_id"]).where("id", "=", m.id).executeTakeFirst();
    if (!cur) continue;
    if (cur.parent_id !== m.before.parent_id) await reparent(db, m.id, m.before.parent_id);
    await setFloorplan(db, m.id, (m.before.floorplan as Record<string, unknown> | null) ?? null);
    places++;
  }
  let deleted = 0;
  for (const c of [...applied.created].reverse()) if (await deletePlace(orgId, c.id, userId)) deleted++;
  await db.updateTable("core_locations_plan_drafts").set({ applied_at: null, applied: null, updated_at: new Date() } as never).where("id", "=", id).execute();
  await platform().activity.log({
    orgId,
    userId,
    action: "layout_undone",
    ref: { module: "core-locations", entityType: "location", entityId: applied.room.id },
    diff: { layout: applied.draft.name, things, places, deleted, left_where_they_are: leftWhereTheyAre },
  });
  void platform().events.emit("core-locations.location.updated", { orgId, locationId: applied.room.id });
  const note =
    `Put back ${plural(things, "thing", "things")}` +
    (places ? `, ${plural(places, "place", "places")}` : "") +
    (deleted ? `, and took away ${plural(deleted, "planned place", "planned places")}` : "") +
    "." +
    (leftWhereTheyAre ? ` ${plural(leftWhereTheyAre, "thing", "things")} moved again since, so ${leftWhereTheyAre === 1 ? "it stays" : "they stay"} where ${leftWhereTheyAre === 1 ? "it is" : "they are"}.` : "");
  return { things, places, deleted, leftWhereTheyAre, note };
}

/** The room as the draft would make it, in words and numbers, for the
 *  assistant: each shelf (real or planned) with its size, the things the
 *  draft or the room puts on it with their outer sizes, and whether they fit.
 *  Shelves are the containers inside the room's containers (a rack's). */
export async function describeDraft(orgId: string, id: string) {
  const db = await dbOf(orgId);
  const draft = await getDraft(orgId, id);
  if (!draft) throw new DraftRefused("There is no such layout.");
  const all = await db.selectFrom("core_locations_locations").select(["id", "name", "parent_id", "metadata", "kind"]).execute();
  const kids = (pid: string) => all.filter((l) => l.parent_id === pid);
  type Shelf = { id: string; name: string; rack: string; w_mm: number | null; h_mm: number | null; planned: boolean };
  const shelves: Shelf[] = [];
  const rackName = new Map<string, string>();
  const racks = [
    ...kids(draft.location_id).filter((l) => l.kind === "container").map((l) => ({ id: l.id, name: l.name, planned: false })),
    ...draft.body.planned.filter((p) => p.parent === draft.location_id).map((p) => ({ id: `${PLANNED}${p.key}`, name: p.name, planned: true })),
  ];
  for (const r of racks) {
    rackName.set(r.id, r.name);
    for (const s of r.planned ? [] : kids(r.id)) {
      const fp = floorplanOf(s.metadata);
      shelves.push({ id: s.id, name: s.name, rack: r.name, w_mm: Number(fp.w_mm) || null, h_mm: Number(fp.d_mm) || null, planned: false });
    }
    for (const p of draft.body.planned.filter((p) => p.parent === r.id)) {
      shelves.push({ id: `${PLANNED}${p.key}`, name: p.name, rack: r.name, w_mm: p.rect.w_mm, h_mm: p.rect.d_mm, planned: true });
    }
  }
  // What is on each shelf now, then the draft's moves over it.
  const where = new Map<string, { kind: string; id: string; into: string; x_mm: number | null }>();
  for (const s of shelves.filter((s) => !s.planned)) {
    for (const c of await platform().placement.contents({ orgId, container: { kind: LOCATION, id: s.id } })) {
      if (c.kind === LOCATION) continue;
      where.set(`${c.kind}:${c.id}`, { kind: c.kind, id: c.id, into: s.id, x_mm: (c.position as { x_mm?: number } | null)?.x_mm ?? null });
    }
  }
  for (const [k, t] of Object.entries(draft.body.things)) where.set(k, { kind: t.kind, id: t.id, into: t.into, x_mm: t.x_mm ?? null });
  const refs = [...where.values()];
  const found = await platform().entities.lookupMany(orgId, refs.map((r) => ({ kind: r.kind, id: r.id })), { system: true }).catch(() => []);
  const sizeNames = new Map<string, string[]>();
  for (const kind of new Set(refs.map((r) => r.kind))) sizeNames.set(kind, await platform().fields.withRole({ orgId, kind, role: OUTER_SIZE_ROLE }).catch(() => []));
  const sizeOf = (kind: string, fields: Record<string, unknown> | undefined): OuterSize | null => {
    const meta = (fields?.metadata && typeof fields.metadata === "object" ? fields.metadata : {}) as Record<string, unknown>;
    for (const n of sizeNames.get(kind) ?? []) {
      const s = parseOuterSize(fields?.[n] ?? meta[n]);
      if (s) return s;
    }
    return null;
  };
  const things = refs.map((r) => {
    const e = found.find((f) => f.kind === r.kind && f.id === r.id);
    const size = sizeOf(r.kind, e?.fields);
    return { kind: r.kind, id: r.id, name: e?.title ?? "a thing", into: r.into, x_mm: r.x_mm, size: size ? { w_mm: size.w_mm, d_mm: size.d_mm, h_mm: size.h_mm } : null };
  });
  const floor = floorOf(all, draft);
  return {
    draft: { id: draft.id, name: draft.name, applied: !!draft.applied_at },
    room: floor.room,
    racks: floor.racks,
    flags: floor.flags,
    shelves: shelves.map((s) => {
      const on = things.filter((t) => t.into === s.id);
      const used = on.reduce((a, t) => a + (t.size?.w_mm ?? 0), 0);
      return {
        ...s,
        things: on.map((t) => ({ kind: t.kind, id: t.id, name: t.name, size: t.size })),
        used_mm: used,
        fits: s.w_mm === null ? null : used <= s.w_mm,
        without_size: on.filter((t) => !t.size).length,
      };
    }),
    elsewhere: things.filter((t) => !shelves.some((s) => s.id === t.into)).map((t) => ({ kind: t.kind, id: t.id, name: t.name, into: t.into, size: t.size })),
  };
}

/** The room's floor as the draft would leave it: each rack's spot, size and
 *  turn, and what stands in a door's swing, before a window, or (when the
 *  room checks aisles) too close to the next thing to walk between. The
 *  same rules the plan draws with (plan-clearance.ts). */
function floorOf(
  all: ReadonlyArray<{ id: string; name: string; parent_id: string | null; kind: string; metadata: unknown }>,
  draft: PlanDraft,
): {
  room: { w_mm: number; d_mm: number; aisle_mm: number | null; walls: PlanWall[] } | null;
  racks: Array<{ id: string; name: string; planned: boolean; x_mm: number; y_mm: number; w_mm: number; d_mm: number; rot: number; own_w_mm: number; own_d_mm: number; h_mm: number | null }>;
  flags: PlanFlag[];
} {
  const places = placesUnderDraft(all.map((l) => ({ ...l, metadata: (l.metadata ?? {}) as Record<string, unknown> })), draft.body);
  const roomRow = places.find((p) => p.id === draft.location_id);
  const fp = floorplanOf(roomRow?.metadata);
  const w = Number(fp.w_mm), d = Number(fp.d_mm);
  if (!roomRow || !(w > 0) || !(d > 0)) return { room: null, racks: [], flags: [] };
  const kids = places.filter((p) => p.parent_id === draft.location_id);
  const boxOf = (m: unknown): PlanBox | null => {
    const f = floorplanOf(m);
    const b = { x_mm: Number(f.x_mm), y_mm: Number(f.y_mm), w_mm: Number(f.w_mm), d_mm: Number(f.d_mm) };
    if (![b.x_mm, b.y_mm].every(Number.isFinite) || !(b.w_mm > 0) || !(b.d_mm > 0)) return null;
    return isRotation(f.rot) ? { ...b, rot: f.rot } : b;
  };
  const ownWalls = (Array.isArray(fp.walls) ? fp.walls : []) as PlanWall[];
  const walls = roomWalls({ w_mm: w, d_mm: d, walls: ownWalls }, kids.filter((k) => k.kind === "area").map((k) => ({ id: k.id, box: boxOf(k.metadata), closet: readCloset(floorplanOf(k.metadata)) })));
  const racks = kids
    .filter((k) => k.kind !== "area" && boxOf(k.metadata) && floorplanOf(k.metadata).wall_mounted !== true)
    .map((k) => {
      const box = boxOf(k.metadata)!;
      const face = floorplanOf(k.metadata).face as { d_mm?: unknown } | undefined;
      const own = ownSize(box);
      return { id: k.id, name: k.name, planned: "planned" in k, ...box, rot: box.rot ?? 0, own_w_mm: own.w_mm, own_d_mm: own.d_mm, h_mm: Number(face?.d_mm) > 0 ? Number(face!.d_mm) : null };
    });
  const aisle = Number(fp.aisle_mm) > 0 ? Number(fp.aisle_mm) : null;
  const flags = planFlags({ room: { w_mm: w, d_mm: d, walls }, items: racks.map((r) => ({ id: r.id, name: r.name, box: { x_mm: r.x_mm, y_mm: r.y_mm, w_mm: r.w_mm, d_mm: r.d_mm }, h_mm: r.h_mm })), aisle_mm: aisle });
  return { room: { w_mm: w, d_mm: d, aisle_mm: aisle, walls }, racks, flags };
}

// ── the doors: HTTP for the page, actions for the assistant ──


export const planDraftsRouter = Router({ mergeParams: true });

const refused = (res: Response, e: unknown) => {
  if (!(e instanceof DraftRefused)) throw e;
  res.status(409).json({ error: { code: "layout_refused", message: e.message } });
};

const DraftCreate = z.object({ name: z.string().max(120).optional(), from: z.string().uuid().optional(), body: z.unknown().optional() });
const DraftPatch = z.object({ name: z.string().max(120).optional(), body: z.unknown().optional() });

planDraftsRouter.get(
  "/plan-drafts/:draftId",
  asyncHandler(async (req, res) => {
    const d = await getDraft(tenantContext(req).org.id, req.params.draftId!);
    if (!d) {
      res.status(404).json({ error: { code: "not_found", message: "There is no such layout." } });
      return;
    }
    res.json(d);
  }),
);

planDraftsRouter.get(
  "/plan-drafts/:draftId/describe",
  asyncHandler(async (req, res) => {
    try {
      res.json(await describeDraft(tenantContext(req).org.id, req.params.draftId!));
    } catch (e) {
      refused(res, e);
    }
  }),
);

// AI-ACTION: core-locations:plan-put
// AI-REACH: action core-locations:plan-put
planDraftsRouter.patch(
  "/plan-drafts/:draftId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:plan-put"))) return;
    const parsed = DraftPatch.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    try {
      res.json(await updateDraft(tenantContext(req).org.id, req.params.draftId!, parsed.data));
    } catch (e) {
      refused(res, e);
    }
  }),
);

// AI-ACTION: core-locations:plan-discard
// AI-REACH: action core-locations:plan-discard
planDraftsRouter.delete(
  "/plan-drafts/:draftId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:plan-discard"))) return;
    const gone = await deleteDraft(tenantContext(req).org.id, req.params.draftId!);
    res.status(gone ? 204 : 404).end();
  }),
);

// AI-ACTION: core-locations:plan-apply
// AI-REACH: action core-locations:plan-apply
planDraftsRouter.post(
  "/plan-drafts/:draftId/apply",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:plan-apply"))) return;
    try {
      res.json(await applyDraft(tenantContext(req).org.id, req.params.draftId!, sessionUser(req).id));
    } catch (e) {
      refused(res, e);
    }
  }),
);

// AI-ACTION: core-locations:plan-undo
// AI-REACH: action core-locations:plan-undo
planDraftsRouter.post(
  "/plan-drafts/:draftId/undo",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:plan-undo"))) return;
    try {
      res.json(await undoApply(tenantContext(req).org.id, req.params.draftId!, sessionUser(req).id));
    } catch (e) {
      refused(res, e);
    }
  }),
);

planDraftsRouter.get(
  "/:id/plan-drafts",
  asyncHandler(async (req, res) => {
    res.json({ items: await listDrafts(tenantContext(req).org.id, req.params.id!) });
  }),
);

// AI-ACTION: core-locations:plan-layout
// AI-REACH: action core-locations:plan-layout
planDraftsRouter.post(
  "/:id/plan-drafts",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:plan-layout"))) return;
    const parsed = DraftCreate.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    try {
      res.status(201).json(await createDraft(tenantContext(req).org.id, req.params.id!, { ...parsed.data, userId: sessionUser(req).id }));
    } catch (e) {
      refused(res, e);
    }
  }),
);

/** The assistant's doors: it proposes a layout as a draft (plan-layout,
 *  plan-put, plan-add-rack, plan-read) and the person applies it; Apply's
 *  confirm card is where they say yes. */
export function registerPlanDraftHandlers(): void {
  const h = platform().actions;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const wrap = (fn: (ctx: Parameters<Parameters<typeof h.registerHandler>[1]>[0]) => Promise<unknown>) => async (ctx: Parameters<Parameters<typeof h.registerHandler>[1]>[0]) => {
    try {
      return { ok: true as const, result: await fn(ctx) };
    } catch (e) {
      if (e instanceof DraftRefused) return { ok: false as const, error: e.message };
      throw e;
    }
  };
  h.registerHandler(
    "core-locations.plan-layout",
    wrap(async (ctx) => {
      const a = (ctx.args ?? {}) as Record<string, unknown>;
      const roomId = ctx.entity?.id ?? str(a.location_id);
      if (!roomId) throw new DraftRefused("Say which room to plan: its place id.");
      const d = await createDraft(ctx.orgId, roomId, { name: str(a.name) || null, from: str(a.from) || null, userId: ctx.userId ?? null });
      return { draft_id: d.id, name: d.name, note: `${d.name} is a draft: nothing has moved yet.` };
    }),
  );
  h.registerHandler(
    "core-locations.plan-put",
    wrap(async (ctx) => {
      const a = (ctx.args ?? {}) as Record<string, unknown>;
      const d = await getDraft(ctx.orgId, str(a.draft_id));
      if (!d) throw new DraftRefused("There is no such layout.");
      const listOf = (v: unknown) => {
        const raw = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
        return (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
      };
      const list = listOf(a.put);
      const racks = listOf(a.move);
      if (!list.length && !racks.length) throw new DraftRefused("Pass `put`: a list of {kind, id, into, x_mm?}, or `move`: a list of {id, x_mm?, y_mm?, turn?}.");
      const things = { ...d.body.things };
      for (const p of list) {
        const kind = str(p.kind), id = str(p.id), into = str(p.into);
        if (!kind || !id || !into) throw new DraftRefused("Each thing to put needs kind, id and into (a place id, or planned:<key>).");
        things[`${kind}:${id}`] = { kind, id, into, ...(typeof p.x_mm === "number" ? { x_mm: p.x_mm } : {}), ...(typeof p.y_mm === "number" ? { y_mm: p.y_mm } : {}) };
      }
      const body = { ...d.body, things, moves: { ...d.body.moves }, planned: [...d.body.planned] };
      if (racks.length) {
        // A rack moved or turned on the room's floor, as the planner's drag
        // and Turn do: a turn is about its middle and keeps it in the room.
        const db = await dbOf(ctx.orgId);
        const all = await db.selectFrom("core_locations_locations").select(["id", "name", "parent_id", "metadata", "kind"]).execute();
        const floor = floorOf(all, d);
        if (!floor.room) throw new DraftRefused("This room has no size on its floor plan, so nothing can be moved on it.");
        for (const m of racks) {
          const id = str(m.id);
          const rack = floor.racks.find((r) => r.id === id);
          if (!rack) throw new DraftRefused(`There is no rack ${id} on this room's floor. Read the layout (plan-read) for the racks and their ids.`);
          let box: PlanBox = { x_mm: rack.x_mm, y_mm: rack.y_mm, w_mm: rack.w_mm, d_mm: rack.d_mm, ...(isRotation(rack.rot) ? { rot: rack.rot } : {}) };
          if (typeof m.x_mm === "number") box.x_mm = m.x_mm;
          if (typeof m.y_mm === "number") box.y_mm = m.y_mm;
          box = { ...box, x_mm: Math.max(0, Math.min(floor.room.w_mm - box.w_mm, Math.round(box.x_mm))), y_mm: Math.max(0, Math.min(floor.room.d_mm - box.d_mm, Math.round(box.y_mm))) };
          const turns = Math.round((Number(m.turn) || 0) / 90) % 4;
          for (let i = 0; i < (turns + 4) % 4; i++) {
            const t = rotated(box, floor.room);
            if (!t) throw new DraftRefused(`${rack.name} is longer than the room, so it cannot turn here.`);
            box = t;
          }
          if (id.startsWith(PLANNED)) {
            const key = id.slice(PLANNED.length);
            body.planned = body.planned.map((p) => (p.key === key ? { ...p, rect: box } : p));
          } else body.moves[id] = { ...body.moves[id], rect: box };
        }
      }
      await updateDraft(ctx.orgId, d.id, { body });
      const said = [list.length ? plural(list.length, "thing", "things") + " placed" : null, racks.length ? plural(racks.length, "rack", "racks") + " moved" : null].filter(Boolean).join(", ");
      return { draft_id: d.id, put: list.length, moved: racks.length, note: `${d.name}: ${said} in the draft. Nothing has moved yet.` };
    }),
  );
  h.registerHandler(
    "core-locations.plan-add-rack",
    wrap(async (ctx) => {
      const a = (ctx.args ?? {}) as Record<string, unknown>;
      const d = await getDraft(ctx.orgId, str(a.draft_id));
      if (!d) throw new DraftRefused("There is no such layout.");
      const size = parseOuterSize(a.size);
      if (!size || !size.h_mm) throw new DraftRefused('Pass `size`: the rack\'s width x depth x height ("1220 x 610 x 1830 mm").');
      const shelves = Math.max(1, Math.min(12, Math.round(Number(a.shelves) || 4)));
      const name = str(a.name) || "Planned rack";
      const key = `rack-${(d.body.planned.length + 1).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const planned = [
        ...d.body.planned,
        ...plannedRack({ key, name, parent: d.location_id, at: { x_mm: Number(a.x_mm) || 0, y_mm: Number(a.y_mm) || 0 }, size: { w_mm: size.w_mm, d_mm: size.d_mm, h_mm: size.h_mm }, shelves }),
      ];
      await updateDraft(ctx.orgId, d.id, { body: { ...d.body, planned } });
      return { draft_id: d.id, rack: `${PLANNED}${key}`, shelves: Array.from({ length: shelves }, (_, i) => `${PLANNED}${key}-s${i + 1}`), note: `${name} with ${plural(shelves, "shelf", "shelves")} is planned in ${d.name}.` };
    }),
  );
  h.registerHandler(
    "core-locations.plan-read",
    wrap(async (ctx) => describeDraft(ctx.orgId, str(((ctx.args ?? {}) as Record<string, unknown>).draft_id))),
  );
  h.registerHandler(
    "core-locations.plan-apply",
    wrap(async (ctx) => applyDraft(ctx.orgId, str(((ctx.args ?? {}) as Record<string, unknown>).draft_id), ctx.userId ?? null)),
  );
  h.registerHandler(
    "core-locations.plan-undo",
    wrap(async (ctx) => {
      const id = str(((ctx.args ?? {}) as Record<string, unknown>).draft_id);
      return { draft_id: id, ...(await undoApply(ctx.orgId, id, ctx.userId ?? null)) };
    }),
  );
  h.registerHandler(
    "core-locations.plan-discard",
    wrap(async (ctx) => {
      const id = str(((ctx.args ?? {}) as Record<string, unknown>).draft_id);
      if (!(await deleteDraft(ctx.orgId, id))) throw new DraftRefused("There is no such layout.");
      return { note: "Discarded the layout. Nothing had moved." };
    }),
  );
  h.registerUndo("core-locations.plan-apply", (result) => {
    const r = (result as { result?: { draft?: { id?: string } } } | null)?.result;
    return r?.draft?.id ? { action_id: "core-locations:plan-undo", args: { draft_id: r.draft.id } } : null;
  });
}
