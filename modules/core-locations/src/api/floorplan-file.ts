// Import and export a whole house as cobblr-floorplan/1
// (@cobblr/platform-contract/floorplan-format).
//
// A person asks any AI for their home as this JSON (the docs and the Copy a
// prompt button hand it the rules), or exports what they have drawn to give
// to one. Import makes or updates the places by name under their parent:
// the site, a level, each room with its size and walls, its zones, its
// containers with their front faces, shelves and drawers. Matching by name
// is what makes it safe to import a file again: the same file twice makes
// nothing new, and export then import changes nothing. Nothing absent from
// the file is deleted. Anything outside its room or face is moved inside and
// said so. The whole import is one step: what it made and what each updated
// place's layout was are returned, and Undo is a function of that.
// See docs/design-decisions/location-floor-plan.md, "A whole house as one file".
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { platform } from "@cobblr/platform-contract";
import { Router } from "express";
import { isEdge, isRotation } from "@cobblr/platform-contract/plan-clearance";
import { FLOORPLAN_FORMAT, problemSentence, readFloorplanFile, type FloorplanContainerT, type FloorplanFileT } from "@cobblr/platform-contract/floorplan-format";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { sessionUser, tenantContext, type CoreLocationsDB } from "../db.js";
import { deletePlace } from "./place-delete.js";
import { asyncHandler, requireRole } from "./util.js";

type Db = Kysely<CoreLocationsDB>;
type Fp = Record<string, unknown>;

export interface ImportStep {
  path: string;
  kind: "area" | "container";
  action: "create" | "update" | "unchanged";
}

/** What an import did: enough to say it and to undo it. */
export interface ImportResult {
  dry_run: boolean;
  steps: ImportStep[];
  warnings: string[];
  created: string[];
  updated: Array<{ id: string; before: unknown }>;
  root: { id: string; name: string } | null;
  note: string;
}

const r = Math.round;
const floorplanOf = (metadata: unknown): Fp => {
  const fp = (metadata as { floorplan?: unknown } | null)?.floorplan;
  return fp && typeof fp === "object" ? { ...(fp as Fp) } : {};
};
/** Walls as stored: whole mm, inside the room, openings only when there are
 *  some. Import and export both write them this way, so a round trip is
 *  exact. */
type OpeningKind = "door" | "window" | "opening";
type OpeningIn = { at_mm: number; w_mm: number; kind?: string; swing?: string; hinge?: string; leaf_mm?: number; sill_mm?: number };
/** An opening as stored: a door keeps its swing, hinge and leaf, a window
 *  its sill, and nothing else keeps either. */
function normOpening(o: OpeningIn) {
  const kind = o.kind === "door" || o.kind === "window" || o.kind === "opening" ? (o.kind as OpeningKind) : undefined;
  return {
    at_mm: r(o.at_mm),
    w_mm: r(o.w_mm),
    ...(kind ? { kind } : {}),
    ...(kind === "door" && isEdge(o.swing) ? { swing: o.swing } : {}),
    ...(kind === "door" && isEdge(o.hinge) ? { hinge: o.hinge } : {}),
    ...(kind === "door" && typeof o.leaf_mm === "number" && o.leaf_mm > 0 ? { leaf_mm: r(o.leaf_mm) } : {}),
    ...(kind === "window" && typeof o.sill_mm === "number" && o.sill_mm >= 0 ? { sill_mm: r(o.sill_mm) } : {}),
  };
}
function normWalls(walls: ReadonlyArray<{ x1: number; y1: number; x2: number; y2: number; openings?: ReadonlyArray<OpeningIn> }>, bound: { w_mm: number; d_mm: number }) {
  return walls.map((w) => ({
    x1: Math.max(0, Math.min(r(w.x1), bound.w_mm)),
    y1: Math.max(0, Math.min(r(w.y1), bound.d_mm)),
    x2: Math.max(0, Math.min(r(w.x2), bound.w_mm)),
    y2: Math.max(0, Math.min(r(w.y2), bound.d_mm)),
    ...(w.openings?.length ? { openings: w.openings.map(normOpening) } : {}),
  }));
}
/** A closet's door as stored on its zone: only what was said. */
function normCloset(c: { door_mm?: number; hinge?: string; swing?: string }): Fp {
  return {
    ...(typeof c.door_mm === "number" && c.door_mm > 0 ? { door_mm: r(c.door_mm) } : {}),
    ...(isEdge(c.hinge) ? { hinge: c.hinge } : {}),
    ...(isEdge(c.swing) ? { swing: c.swing } : {}),
  };
}
/** Equal as values: Postgres keeps a jsonb object's keys in its own order. */
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

/** A rect kept inside its bound; a warning when it had to move. */
function clamp(rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number }, bound: { w_mm: number; d_mm: number }, what: string, where: string, warn: (s: string) => void) {
  const w = Math.min(r(rect.w_mm), bound.w_mm);
  const d = Math.min(r(rect.d_mm), bound.d_mm);
  const x = Math.max(0, Math.min(r(rect.x_mm), bound.w_mm - w));
  const y = Math.max(0, Math.min(r(rect.y_mm), bound.d_mm - d));
  if (w !== r(rect.w_mm) || d !== r(rect.d_mm) || x !== r(rect.x_mm) || y !== r(rect.y_mm)) warn(`${what} reached outside ${where}, so it was moved inside.`);
  return { x_mm: x, y_mm: y, w_mm: w, d_mm: d };
}

/** Import a plan. `dryRun`: say what it would do and write nothing. */
export async function importFloorplan(orgId: string, plan: FloorplanFileT, opts: { dryRun: boolean; userId: string | null }): Promise<ImportResult> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Db;
  const steps: ImportStep[] = [];
  const warnings: string[] = [];
  const created: string[] = [];
  const updated: ImportResult["updated"] = [];
  const unit = plan.units_entered ?? "mm";
  let fake = 0;

  /** The place called `name` under `parentId`, made or brought up to date. */
  const ensure = async (parentId: string | null, name: string, kind: "area" | "container", wantOf: Fp | ((cur: Fp) => Fp), path: string): Promise<string> => {
    const row = parentId?.startsWith("new:")
      ? undefined
      : await db
          .selectFrom("core_locations_locations")
          .select(["id", "kind", "metadata", "depth"])
          .where((eb) => (parentId ? eb("parent_id", "=", parentId) : eb("parent_id", "is", null)))
          .where(sql<boolean>`lower(name) = lower(${name})`)
          .executeTakeFirst();
    if (row) {
      if (row.kind !== kind) warnings.push(`${path} is already ${row.kind === "area" ? "a room or area" : "a container"} here; kept it that way.`);
      const cur = floorplanOf(row.metadata);
      const want = typeof wantOf === "function" ? wantOf(cur) : wantOf;
      const changed = Object.keys(want).some((k) => !same(cur[k], want[k]));
      steps.push({ path, kind, action: changed ? "update" : "unchanged" });
      if (changed && !opts.dryRun) {
        updated.push({ id: row.id, before: (row.metadata as { floorplan?: unknown } | null)?.floorplan ?? null });
        await db
          .updateTable("core_locations_locations")
          .set({ metadata: platform().db.mergeJsonb("metadata", { floorplan: { ...cur, ...want } }) as never, updated_at: new Date() } as never)
          .where("id", "=", row.id)
          .execute();
      }
      return row.id;
    }
    const want = typeof wantOf === "function" ? wantOf({}) : wantOf;
    steps.push({ path, kind, action: "create" });
    if (opts.dryRun) return `new:${++fake}`;
    const parent = parentId ? await db.selectFrom("core_locations_locations").select("depth").where("id", "=", parentId).executeTakeFirst() : null;
    // SIBLING-DUP-OK: matched by name under this parent just above, so it is made only when none is there.
    const ins = await db
      .insertInto("core_locations_locations")
      .values({ name, parent_id: parentId, depth: parent ? parent.depth + 1 : 0, kind, metadata: (Object.keys(want).length ? { floorplan: want } : {}) as never })
      .returning("id")
      .executeTakeFirstOrThrow();
    created.push(ins.id);
    await platform().activity.log({
      orgId,
      userId: opts.userId,
      action: "location_created",
      ref: { module: "core-locations", entityType: "location", entityId: ins.id },
      diff: { name, parent_id: parentId, via: "floor plan import" },
    });
    return ins.id;
  };

  const container = async (c: FloorplanContainerT, parentId: string, bound: { w_mm: number; d_mm: number }, where: string, path: string, onFloor: boolean) => {
    const rect = clamp(c, bound, c.name, where, (s) => warnings.push(s));
    const shelves = c.face?.shelves ?? [];
    const kids = c.containers ?? [];
    const faceH = c.h_mm ? r(c.h_mm) : null;
    // A face keeps its own width when it has one (it is not always the
    // footprint's, location-floor-plan.md "A container's face is not its
    // footprint"); the file says only how tall it is.
    let face = { w_mm: rect.w_mm, d_mm: faceH ?? rect.d_mm };
    const id = await ensure(
      parentId,
      c.name,
      "container",
      (cur) => {
        const want: Fp = { ...rect };
        if (onFloor) want.wall_mounted = c.wall_mounted === true;
        if (onFloor && c.rot) want.rot = c.rot;
        if (faceH || shelves.length || kids.length) {
          const had = cur.face && typeof cur.face === "object" ? (cur.face as Fp) : null;
          want.face = had ? { ...had, d_mm: faceH ?? had.d_mm } : { w_mm: rect.w_mm, d_mm: faceH ?? rect.d_mm, view: "front", unit };
          face = { w_mm: Number((want.face as Fp).w_mm), d_mm: Number((want.face as Fp).d_mm) };
        }
        return want;
      },
      path,
    );
    // A shelf is the space from its surface up to the next one (or the top),
    // drawn on the face; that is where things stand on it.
    const sorted = [...shelves].sort((a, b) => a.from_bottom_mm - b.from_bottom_mm);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      const bottom = Math.min(r(s.from_bottom_mm), face.d_mm - 1);
      const top = i + 1 < sorted.length ? Math.min(r(sorted[i + 1]!.from_bottom_mm), face.d_mm) : face.d_mm;
      await ensure(id, s.name, "container", { x_mm: 0, y_mm: face.d_mm - top, w_mm: face.w_mm, d_mm: Math.max(1, top - bottom), shelf: true }, `${path} › ${s.name}`);
    }
    for (const k of kids) await container(k, id, face, c.name, `${path} › ${k.name}`, false);
  };

  const site = plan.site ? await ensure(null, plan.site.name, "area", {}, plan.site.name) : null;
  for (const room of plan.rooms) {
    const level = room.level ? await ensure(site, room.level, "area", {}, [plan.site?.name, room.level].filter(Boolean).join(" › ")) : null;
    const parent = level ?? site;
    const path = [plan.site?.name, room.level, room.name].filter(Boolean).join(" › ");
    const bound = { w_mm: r(room.w_mm), d_mm: r(room.d_mm) };
    const walls = normWalls(room.walls ?? [], bound);
    if ((room.walls ?? []).some((w, i) => w.x1 !== walls[i]!.x1 || w.y1 !== walls[i]!.y1 || w.x2 !== walls[i]!.x2 || w.y2 !== walls[i]!.y2)) {
      warnings.push(`A wall in ${room.name} reached outside it, so it was cut at the room's edge.`);
    }
    const roomId = await ensure(parent, room.name, "area", (cur) => ({ ...bound, unit: (cur.unit as string | undefined) ?? unit, view: "plan", walls }), path);
    for (const z of room.zones ?? []) {
      const at: Fp = clamp(z, bound, z.name, room.name, (s) => warnings.push(s));
      if (z.closet) at.closet = normCloset(z.closet);
      await ensure(roomId, z.name, "area", at, `${path} › ${z.name}`);
    }
    for (const c of room.containers ?? []) await container(c, roomId, bound, room.name, `${path} › ${c.name}`, true);
  }

  const n = (k: ImportStep["action"]) => steps.filter((s) => s.action === k).length;
  const plural = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  const parts = [
    n("create") ? `${opts.dryRun ? "make" : "made"} ${plural(n("create"), "place", "places")}` : null,
    n("update") ? `${opts.dryRun ? "update" : "updated"} ${plural(n("update"), "place", "places")}` : null,
  ].filter(Boolean);
  const sentence = parts.length ? `${opts.dryRun ? "Would " : ""}${parts.join(" and ")}.` : "Nothing to change.";
  const as = n("unchanged") ? ` ${plural(n("unchanged"), "place is", "places are")} already as the file says.` : "";
  const note = (sentence.charAt(0).toUpperCase() + sentence.slice(1) + as).trim();
  const rootId = site ?? null;
  if (!opts.dryRun && (created.length || updated.length)) {
    const firstRoom = await db.selectFrom("core_locations_locations").select(["id"]).where("name", "=", plan.rooms[0]!.name).executeTakeFirst();
    const anchor = rootId && !rootId.startsWith("new:") ? rootId : (firstRoom?.id ?? created[0]);
    if (anchor) {
      await platform().activity.log({
        orgId,
        userId: opts.userId,
        action: "floorplan_imported",
        ref: { module: "core-locations", entityType: "location", entityId: anchor },
        diff: { made: created.length, updated: updated.length, warnings: warnings.length },
      });
      void platform().events.emit("core-locations.location.updated", { orgId, locationId: anchor });
    }
  }
  return {
    dry_run: opts.dryRun,
    steps,
    warnings,
    created,
    updated,
    root: rootId && plan.site ? { id: rootId, name: plan.site.name } : null,
    note,
  };
}

/** Undo an import: each place it updated back to the layout it had, each it
 *  made deleted (newest first; a thing put in one since stays in the
 *  workspace with no place set, as any delete leaves it). */
export async function undoImport(orgId: string, result: Pick<ImportResult, "created" | "updated">, userId: string | null): Promise<{ restored: number; deleted: number; note: string }> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Db;
  let restored = 0;
  for (const u of result.updated) {
    await db
      .updateTable("core_locations_locations")
      .set({ metadata: platform().db.mergeJsonb("metadata", { floorplan: (u.before as Fp | null) ?? null }) as never, updated_at: new Date() } as never)
      .where("id", "=", u.id)
      .execute();
    restored++;
  }
  let deleted = 0;
  for (const id of [...result.created].reverse()) {
    const still = await db.selectFrom("core_locations_locations").select("id").where("id", "=", id).executeTakeFirst();
    if (still && (await deletePlace(orgId, id, userId))) deleted++;
  }
  return { restored, deleted, note: `Took back the import: ${deleted} made, ${restored} put back as they were.` };
}

/** A place and everything drawn under it, as cobblr-floorplan/1. `rootId` is a
 *  room (exported alone) or a place holding rooms (the site; a room under it
 *  with a place between keeps that place as its level). */
export async function exportFloorplan(orgId: string, rootId: string): Promise<FloorplanFileT | null> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Db;
  const all = await db.selectFrom("core_locations_locations").select(["id", "name", "parent_id", "kind", "metadata", "position"]).orderBy("position").orderBy("name").execute();
  const root = all.find((l) => l.id === rootId);
  if (!root) return null;
  const kids = (id: string) => all.filter((l) => l.parent_id === id);
  const isRoom = (l: (typeof all)[number]) => {
    const fp = floorplanOf(l.metadata);
    // A room has its own size and is not a front face; one drawn on a
    // floor's plan has a spot there too, and says it is a plan (or has walls).
    if (l.kind !== "area" || !(Number(fp.w_mm) > 0) || !(Number(fp.d_mm) > 0) || fp.view === "front") return false;
    return fp.x_mm === undefined || fp.view === "plan" || fp.unit !== undefined || Array.isArray(fp.walls);
  };
  const rooms: Array<{ room: (typeof all)[number]; level: string | null }> = [];
  if (isRoom(root)) rooms.push({ room: root, level: null });
  else {
    const walk = (id: string, level: string | null) => {
      for (const k of kids(id)) {
        if (isRoom(k)) rooms.push({ room: k, level });
        else if (k.kind === "area") walk(k.id, k.name);
      }
    };
    walk(root.id, null);
  }
  let unit: FloorplanFileT["units_entered"];
  const containerOut = (l: (typeof all)[number]): FloorplanContainerT => {
    const fp = floorplanOf(l.metadata);
    const face = fp.face && typeof fp.face === "object" ? (fp.face as Fp) : null;
    const h = face ? Number(face.d_mm) : null;
    const children = kids(l.id).filter((k) => k.kind !== "area" && floorplanOf(k.metadata).w_mm !== undefined);
    const shelves = children.filter((k) => floorplanOf(k.metadata).shelf === true);
    const nested = children.filter((k) => floorplanOf(k.metadata).shelf !== true);
    const out: FloorplanContainerT = { name: l.name, x_mm: Number(fp.x_mm), y_mm: Number(fp.y_mm), w_mm: Number(fp.w_mm), d_mm: Number(fp.d_mm) };
    if (h) out.h_mm = h;
    if (fp.wall_mounted !== undefined) out.wall_mounted = fp.wall_mounted === true;
    if (isRotation(fp.rot)) out.rot = fp.rot;
    if (shelves.length && h) {
      out.face = {
        shelves: shelves
          .map((s) => {
            const sf = floorplanOf(s.metadata);
            return { name: s.name, from_bottom_mm: h - Number(sf.y_mm) - Number(sf.d_mm) };
          })
          .sort((a, b) => a.from_bottom_mm - b.from_bottom_mm),
      };
    }
    if (nested.length) out.containers = nested.map(containerOut);
    return out;
  };
  const out: FloorplanFileT = {
    format: FLOORPLAN_FORMAT,
    ...(isRoom(root) ? {} : { site: { name: root.name } }),
    rooms: rooms.map(({ room, level }) => {
      const fp = floorplanOf(room.metadata);
      if (!unit && typeof fp.unit === "string") unit = fp.unit as FloorplanFileT["units_entered"];
      const zones = kids(room.id).filter((k) => k.kind === "area" && floorplanOf(k.metadata).x_mm !== undefined && !isRoom(k));
      const containers = kids(room.id).filter((k) => k.kind !== "area" && floorplanOf(k.metadata).x_mm !== undefined);
      return {
        name: room.name,
        ...(level ? { level } : {}),
        w_mm: Number(fp.w_mm),
        d_mm: Number(fp.d_mm),
        ...(Array.isArray(fp.walls) && fp.walls.length ? { walls: normWalls(fp.walls as never, { w_mm: Number(fp.w_mm), d_mm: Number(fp.d_mm) }) } : {}),
        ...(zones.length
          ? {
              zones: zones.map((z) => {
                const f = floorplanOf(z.metadata);
                const closet = f.closet && typeof f.closet === "object" ? normCloset(f.closet as never) : null;
                return { name: z.name, x_mm: Number(f.x_mm), y_mm: Number(f.y_mm), w_mm: Number(f.w_mm), d_mm: Number(f.d_mm), ...(closet ? { closet } : {}) };
              }),
            }
          : {}),
        ...(containers.length ? { containers: containers.map(containerOut) } : {}),
      };
    }),
  };
  if (unit) out.units_entered = unit;
  if (!out.rooms.length) return null;
  return out;
}

// ── the doors ──


export const floorplanFileRouter = Router({ mergeParams: true });

/** Read what a client or the assistant sent: the plan, or the sentences
 *  saying what is wrong with it, by line and field. */
export function readPlanInput(raw: unknown): { plan: FloorplanFileT } | { problems: string[] } {
  const read = readFloorplanFile(raw);
  return read.plan ? { plan: read.plan } : { problems: read.problems.map(problemSentence) };
}

// AI-ACTION: core-locations:import-floorplan
// AI-REACH: action core-locations:import-floorplan
floorplanFileRouter.post(
  "/floorplan/import",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:import-floorplan"))) return;
    const body = (req.body ?? {}) as { plan?: unknown; dry_run?: unknown };
    const read = readPlanInput(body.plan);
    if ("problems" in read) {
      res.status(400).json({ error: { code: "bad_plan", message: read.problems[0], details: { problems: read.problems } } });
      return;
    }
    res.json(await importFloorplan(tenantContext(req).org.id, read.plan, { dryRun: body.dry_run === true, userId: sessionUser(req).id }));
  }),
);

// AI-ACTION: core-locations:undo-floorplan-import
// AI-REACH: action core-locations:undo-floorplan-import
floorplanFileRouter.post(
  "/floorplan/import/undo",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-locations:undo-floorplan-import"))) return;
    const imp = readImportResult((req.body as { import?: unknown } | null)?.import);
    if (!imp) {
      res.status(400).json({ error: { code: "invalid_body", message: "Send the import to undo, as the import answered it." } });
      return;
    }
    res.json(await undoImport(tenantContext(req).org.id, imp, sessionUser(req).id));
  }),
);

floorplanFileRouter.get(
  "/:id/floorplan/export",
  asyncHandler(async (req, res) => {
    const out = await exportFloorplan(tenantContext(req).org.id, req.params.id!);
    if (!out) {
      res.status(404).json({ error: { code: "no_plan", message: "There is no room drawn here to export." } });
      return;
    }
    res.json(out);
  }),
);

/** An import result sent back for its undo: only ids, checked. */
export function readImportResult(raw: unknown): Pick<ImportResult, "created" | "updated"> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { created?: unknown; updated?: unknown };
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  if (!Array.isArray(o.created) || !Array.isArray(o.updated)) return null;
  if (!o.created.every(uuid)) return null;
  const updated = (o.updated as Array<{ id?: unknown; before?: unknown }>).filter((u) => uuid(u?.id)).map((u) => ({ id: u.id as string, before: u.before ?? null }));
  return { created: o.created as string[], updated };
}

/** The assistant's doors: import a plan someone handed over (always shown
 *  as a dry run first by the card), undo it, export a place's plan. */
export function registerFloorplanFileHandlers(): void {
  const h = platform().actions;
  h.registerHandler("core-locations.import-floorplan", async (ctx) => {
    const a = (ctx.args ?? {}) as { plan?: unknown; dry_run?: unknown };
    const read = readPlanInput(a.plan);
    if ("problems" in read) return { ok: false, error: `That plan does not read. ${read.problems.slice(0, 3).join(" ")}` };
    const result = await importFloorplan(ctx.orgId, read.plan, { dryRun: a.dry_run === true || a.dry_run === "true", userId: ctx.userId ?? null });
    return { ok: true, result };
  });
  h.registerHandler("core-locations.undo-floorplan-import", async (ctx) => {
    const imp = readImportResult((ctx.args as { import?: unknown } | null)?.import);
    if (!imp) return { ok: false, error: "nothing to undo" };
    return { ok: true, result: await undoImport(ctx.orgId, imp, ctx.userId ?? null) };
  });
  h.registerHandler("core-locations.export-floorplan", async (ctx) => {
    const id = ctx.entity?.id ?? String((ctx.args as { location_id?: unknown } | null)?.location_id ?? "");
    const out = id ? await exportFloorplan(ctx.orgId, id) : null;
    if (!out) return { ok: false, error: "There is no room drawn there to export." };
    return { ok: true, result: { plan: out, note: `${out.rooms.length} ${out.rooms.length === 1 ? "room" : "rooms"} as cobblr-floorplan/1.` } };
  });
  h.registerUndo("core-locations.import-floorplan", (result) => {
    const r = (result as { result?: ImportResult } | null)?.result;
    if (!r || r.dry_run || (!r.created.length && !r.updated.length)) return null;
    return { action_id: "core-locations:undo-floorplan-import", args: { import: { created: r.created, updated: r.updated } } };
  });
}
