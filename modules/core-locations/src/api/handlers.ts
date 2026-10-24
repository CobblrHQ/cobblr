// core-locations:reorder — the AI-reachable form of POST /locations/reorder.
//
// `position` on a location is maintained by the module: the update route
// refuses it, because a caller setting it there was silently discarded while
// the call returned 200. Refusing is honest, but it left the capability with no
// door at all — asked to order twelve racks, the assistant could only report
// that it could not. A workspace-scoped ACTION is the repo's answer for
// something that acts on a set rather than one record (core-units:add-unit and
// labels:set-code are the precedents): it rides the generic invoke_action rail,
// so it inherits the confirm gate, the permission check and the change ledger
// without a bespoke tool.
//
// It shares ReorderIds + applyOrder with the HTTP route, so dragging in the
// tree and asking for an order cannot come to mean different things.

import { platform, readListArg, requireActionEntity } from "@cobblr/platform-contract";
import { PLAN_COLOURS, planColourOf, readPlanColour } from "@cobblr/platform-contract/plan-colours";
import type { Kysely } from "kysely";
import { ReorderIds, applyOrder } from "./locations.js";
import { MoveRefused, moveEverything, planMove, putBackEverything, readMoveResult } from "./move-everything.js";
import type { CoreLocationsDB } from "../db.js";

export function registerLocationsHandlers(): void {
  registerUndos();
  // Move everything out of one place into another (move-everything.ts): the
  // assistant's door to what the place page's "Move everything to…" does.
  // The card says what stays as well as what goes: the place being emptied
  // keeps its own spot (#8050).
  platform().actions.registerPlanner("core-locations.move-everything", async (ctx) => {
    const read = readMoveArgs(ctx.args);
    if ("error" in read) return read;
    try {
      return await planMove(ctx.orgId, requireActionEntity(ctx).id, read.to, read.opts);
    } catch (e) {
      if (e instanceof MoveRefused) return { error: e.message };
      throw e;
    }
  });
  platform().actions.registerHandler("core-locations.move-everything", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const read = readMoveArgs(ctx.args);
    if ("error" in read) return { ok: false, error: read.error };
    try {
      const moved = await moveEverything(ctx.orgId, entity.id, read.to, { ...read.opts, userId: ctx.userId ?? null });
      return { ok: true, result: { ...moved, note: moveSentence(moved) } };
    } catch (e) {
      if (e instanceof MoveRefused) return { ok: false, error: e.message };
      throw e;
    }
  });
  // Exists only as the way back for move-everything.
  platform().actions.registerHandler("core-locations.put-back-everything", async (ctx) => {
    const move = readMoveResult((ctx.args as { move?: unknown } | null)?.move);
    if (!move) return { ok: false, error: "nothing to put back" };
    try {
      const back = await putBackEverything(ctx.orgId, move, ctx.userId ?? null);
      return { ok: true, result: { ...back, move } };
    } catch (e) {
      if (e instanceof MoveRefused) return { ok: false, error: e.message };
      throw e;
    }
  });
  // A place's colour on its floor plan: the assistant's door to the swatches
  // in Edit layout ("make the red chest's drawers red").
  platform().actions.registerHandler("core-locations.set-plan-colour", async (ctx) => {
    const entity = requireActionEntity(ctx);
    const args = ctx.args as { colour?: unknown; outline_group?: unknown } | null;
    const raw = args?.colour;
    const clear = raw == null || (typeof raw === "string" && ["", "none", "no colour", "no color", "clear"].includes(raw.trim().toLowerCase()));
    const colour = clear ? null : readPlanColour(raw);
    if (!clear && !colour) {
      return { ok: false, error: `Pass \`colour\`: one of ${PLAN_COLOURS.join(", ")}, or "none" to take it off.` };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreLocationsDB>;
    const row = await db
      .selectFrom("core_locations_locations")
      .select(["id", "name", "metadata"])
      .where("id", "=", entity.id)
      .executeTakeFirst();
    if (!row) return { ok: false, error: `no location with id ${entity.id}` };
    const previous = planColourOf(row.metadata);
    // The whole floorplan goes back, so its size and spot are kept: the
    // metadata merge is one level deep.
    const fp = { ...(((row.metadata as { floorplan?: Record<string, unknown> } | null)?.floorplan ?? {}) as Record<string, unknown>) };
    const previousGroup = typeof fp.outline_tag_id === "string" ? fp.outline_tag_id : "auto";
    if (args?.outline_group === "auto") delete fp.outline_tag_id;
    else fp.outline_tag_id = typeof args?.outline_group === "string" ? args.outline_group : "custom";
    if (colour) fp.color = colour;
    else delete fp.color;
    await db
      .updateTable("core_locations_locations")
      .set({ metadata: platform().db.mergeJsonb("metadata", { floorplan: fp }) as never, updated_at: new Date() } as never)
      .where("id", "=", row.id)
      .execute();
    void platform().events.emit("core-locations.location.updated", { orgId: ctx.orgId, locationId: row.id });
    return {
      ok: true,
      result: {
        id: row.id,
        previous: previous ?? "none",
        previous_group: previousGroup,
        colour: colour ?? "none",
        note: colour ? `${row.name} is ${colour} on the plan.` : `${row.name} has no colour on the plan.`,
      },
    };
  });
  platform().actions.registerHandler("core-locations.reorder", async (ctx) => {
    // `ids` is a list arg: a real array from invoke_action, a delimited string
    // from a wire's text field. readListArg makes those the same thing — an
    // Array.isArray check here silently ignored the second form.
    const ids = readListArg(ctx.args, "ids");
    const parsed = ReorderIds.safeParse(ids);
    if (!parsed.success) {
      return {
        ok: false,
        error:
          "Pass `ids`: the location ids of ONE parent's children, in the order you want them, as a list, e.g. [\"<id-a>\", \"<id-b>\"]. Use list_records on core-locations:location to read them, keeping only the children of the parent being ordered.",
      };
    }

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreLocationsDB>;

    // Every id must exist, and they must be siblings. Ordering a set that spans
    // two parents silently renumbers both groups against each other, which
    // looks like the wrong thing moved.
    const rows = await db
      .selectFrom("core_locations_locations")
      .select(["id", "name", "parent_id", "position"])
      .where("id", "in", parsed.data)
      .execute();
    if (rows.length !== parsed.data.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = parsed.data.filter((id) => !found.has(id));
      return { ok: false, error: `no location with id ${missing.join(", ")}` };
    }
    const parents = new Set(rows.map((r) => r.parent_id ?? "«root»"));
    if (parents.size > 1) {
      return {
        ok: false,
        error:
          "Those locations do not share a parent. Order one parent's children at a time: position is a sibling order, not a global one.",
      };
    }

    // The order before, so the way back is the same action the other way.
    const previous = previousOrder(rows);
    await applyOrder(db as never, parsed.data);
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    return {
      ok: true,
      result: {
        previous,
        ordered: parsed.data.map((id, i) => ({ position: i, id, name: byId.get(id) })),
        note: "Sibling order updated. The tree lists shallowest first, then this order, then alphabetically.",
      },
    };
  });
}

/** move-everything's arguments, read once for the card and the move. */
function readMoveArgs(args: unknown): { to: string | { kind: string; id: string }; opts: { places: boolean; thenDelete: boolean } } | { error: string } {
  const a = (args ?? {}) as { to?: unknown; to_kind?: unknown; places?: unknown; then_delete?: unknown };
  const to = typeof a.to === "string" ? a.to.trim() : "";
  const toKind = typeof a.to_kind === "string" ? a.to_kind.trim() : "";
  if (!to) return { error: "Pass `to`: the id of the place to move everything into." };
  return {
    to: toKind ? { kind: toKind, id: to } : to,
    opts: { places: a.places === true || a.places === "true", thenDelete: a.then_delete === true || a.then_delete === "true" },
  };
}

/** What a move did, in words. */
export function moveSentence(m: { from: { name: string }; to: { name: string }; things: unknown[]; places: unknown[]; deleted: boolean }): string {
  const what = [
    m.things.length ? `${m.things.length} ${m.things.length === 1 ? "thing" : "things"}` : null,
    m.places.length ? `${m.places.length} ${m.places.length === 1 ? "place" : "places"}` : null,
  ].filter(Boolean);
  const moved = what.length ? `Moved ${what.join(" and ")} from ${m.from.name} into ${m.to.name}.` : `${m.from.name} had nothing in it to move.`;
  return m.deleted ? `${moved} Deleted ${m.from.name}.` : moved;
}

function registerUndos(): void {
  platform().actions.registerUndo("core-locations.move-everything", (result) => {
    const move = readMoveResult((result as { result?: unknown } | null)?.result);
    if (!move || (!move.things.length && !move.places.length && !move.deleted)) return null;
    return { action_id: "core-locations:put-back-everything", args: { move } };
  });
  platform().actions.registerUndo("core-locations.put-back-everything", (result) => {
    const move = readMoveResult((result as { result?: { move?: unknown } } | null)?.result?.move);
    if (!move) return null;
    return {
      action_id: "core-locations:move-everything",
      entity_kind: "core-locations:location",
      entity_id: move.from.id,
      args: { to: move.to.id, places: move.places.length > 0, then_delete: move.deleted },
    };
  });
  platform().actions.registerUndo("core-locations.set-plan-colour", (result) => {
    const r = (result as { result?: { id?: unknown; previous?: unknown; previous_group?: unknown } } | null)?.result;
    if (typeof r?.id !== "string") return null;
    return {
      action_id: "core-locations:set-plan-colour",
      entity_kind: "core-locations:location",
      entity_id: r.id,
      args: { colour: typeof r.previous === "string" ? r.previous : "none", outline_group: typeof r.previous_group === "string" ? r.previous_group : "auto" },
    };
  });
  platform().actions.registerUndo("core-locations.reorder", (result) => {
    const prev = (result as { result?: { previous?: unknown } } | null)?.result?.previous;
    if (!Array.isArray(prev) || !prev.length) return null;
    return { action_id: "core-locations:reorder", args: { ids: prev } };
  });
}

/** The order the tree showed these siblings in before a reorder: position,
 *  then name, the tree's own tiebreak. Untouched locations all sit at
 *  position 0, and an undo that ordered those by id put them back in an
 *  order nobody had seen (measured on the rig, 2026-09-13). */
export function previousOrder(rows: ReadonlyArray<{ id: string; name: string; position: number | string | null }>): string[] {
  return [...rows]
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((r) => r.id);
}
