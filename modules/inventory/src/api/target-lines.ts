// A consumer's LINE drawing on a consumable: one requirement of a pattern
// (its Main Color, its Contrast A) served by its own balls.
//
// consumption-ledger.md is the model: a model part counts its unopened units,
// an opened unit is a child part holding what is left in it, and a unit bound
// to a project is an allocation on that child. This file adds the one thing a
// pattern with more than one yarn needed and the per-unit panel could not say:
// WHICH of the pattern's yarns a reservation or a bound ball serves (the
// allocation's `target_line`). With it, each line has its own balls, its own
// usage so far, and can move to a different yarn without disturbing the rest.
//
// Every quantity moves through applyStockDelta, the one writer of qty and the
// ledger, with the line's allocation as the source, so a pattern's use of a
// ball is a statement line on that ball ("-333 m · Corner-to-corner throw")
// and there is no second path to disagree with it.
//
// The four operations, each a handler other modules invoke through
// platform().actions (the projects module, when a pattern is done or a yarn
// is swapped; it never touches these tables):
//   reserve-for-line   hold N unopened units of a model for a line
//   line-usage         what each line has used so far, and which balls it holds
//   use-for-line       take an amount for a line: its bound balls first, then
//                      open partials of the same yarn, then fresh units
//   release-line       let a line go: reservations released, bound balls
//                      returned to the pool as open partials (never undone)

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { capacitySourceField, consumptionUnitOf } from "../consumption-unit.js";
import { UNIT_OF_KEY } from "../on-hand.js";
import { applyStockDelta } from "./action-handlers.js";
import { reserveAllocation, settleAllocation } from "./allocations.js";

export interface LineRef {
  targetModule: string;
  targetType: string;
  targetId: string;
  line: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

async function tenant(orgId: string): Promise<Kysely<InventoryDB>> {
  return (await platform().tenants.getDb(orgId)) as Kysely<InventoryDB>;
}

/** How much one unit of a model holds, and in what (333, "m"), from the same
 *  field the per-unit panel reads (capacity's template, else metadata). */
export async function unitCapacity(
  orgId: string,
  model: { instance: string; metadata: unknown },
): Promise<{ capacity: number | null; unit: string | null }> {
  const kind = model.instance && model.instance !== "inventory" ? `${model.instance}:item` : "inventory:part";
  const defs = (await platform().entities.fieldsFor(orgId, kind).catch(() => [])) as Array<{ name: string; template?: string | null }>;
  const unit = consumptionUnitOf(defs as Parameters<typeof consumptionUnitOf>[0]);
  const source = capacitySourceField(defs.find((d) => d.name === "capacity")?.template ?? null);
  const meta = (model.metadata ?? {}) as Record<string, unknown>;
  return { capacity: (source ? num(meta[source]) : null) ?? num(meta.capacity) ?? num(meta.length_per_skein), unit };
}

function lineWhere(ref: LineRef) {
  return {
    target_module: ref.targetModule,
    target_entity_type: ref.targetType,
    target_entity_id: ref.targetId,
    target_line: ref.line,
  };
}

async function lineAllocations(db: Kysely<InventoryDB>, ref: LineRef, statuses: string[] = ["reserved", "consumed", "released"]) {
  const w = lineWhere(ref);
  return db
    .selectFrom("inventory_allocations as a")
    .innerJoin("inventory_parts as p", "p.id", "a.part_id")
    .select([
      "a.id",
      "a.part_id",
      "a.qty",
      "a.status",
      "p.name as part_name",
      "p.qty as part_qty",
      sql<string | null>`p.metadata->>${UNIT_OF_KEY}`.as("unit_of"),
    ])
    .where("a.target_module", "=", w.target_module)
    .where("a.target_entity_type", "=", w.target_entity_type)
    .where("a.target_entity_id", "=", w.target_entity_id)
    .where("a.target_line", "=", w.target_line)
    .where("a.status", "in", statuses as never)
    .orderBy("a.reserved_at", "asc")
    .execute();
}

export interface LineUsage {
  line: string;
  /** Measured withdrawals from the line's balls (metres off a skein). */
  used_measure: number;
  /** Whole units taken off a model for the line (a pattern with no length). */
  used_units: number;
  /** Unopened units still held for the line, per model. */
  reserved: { part_id: string; part_name: string; qty: number }[];
  /** Open balls bound to the line, with what is left in each. */
  bound: { part_id: string; part_name: string; model_id: string | null; left: number }[];
  /** Every model the line has drawn on or holds, first to last. */
  models: string[];
}

/** What each line of a target has used and holds. */
export async function lineUsage(orgId: string, target: Omit<LineRef, "line">): Promise<LineUsage[]> {
  const db = await tenant(orgId);
  const allocs = await db
    .selectFrom("inventory_allocations as a")
    .innerJoin("inventory_parts as p", "p.id", "a.part_id")
    .select(["a.id", "a.part_id", "a.qty", "a.status", "a.target_line", "p.name as part_name", "p.qty as part_qty", sql<string | null>`p.metadata->>${UNIT_OF_KEY}`.as("unit_of")])
    .where("a.target_module", "=", target.targetModule)
    .where("a.target_entity_type", "=", target.targetType)
    .where("a.target_entity_id", "=", target.targetId)
    .where("a.target_line", "is not", null)
    .orderBy("a.reserved_at", "asc")
    .execute();
  if (allocs.length === 0) return [];
  const ledger = await db
    .selectFrom("inventory_consumption")
    .select(["part_id", "delta", "source_id"])
    .where("source_kind", "=", "allocation")
    .where("source_id", "in", allocs.map((a) => a.id))
    .where(sql<boolean>`delta < 0`)
    .execute();
  const byLine = new Map<string, LineUsage>();
  for (const a of allocs) {
    const line = a.target_line!;
    const u = byLine.get(line) ?? { line, used_measure: 0, used_units: 0, reserved: [], bound: [], models: [] };
    const model = a.unit_of ?? a.part_id;
    if (!u.models.includes(model)) u.models.push(model);
    for (const r of ledger) {
      if (r.source_id !== a.id) continue;
      if (a.unit_of) u.used_measure += -Number(r.delta);
      else u.used_units += -Number(r.delta);
    }
    if (a.status === "reserved") {
      if (a.unit_of) u.bound.push({ part_id: a.part_id, part_name: a.part_name, model_id: a.unit_of, left: Number(a.part_qty) });
      else u.reserved.push({ part_id: a.part_id, part_name: a.part_name, qty: Number(a.qty) });
    }
    byLine.set(line, u);
  }
  return [...byLine.values()];
}

/** Hold `qty` unopened units of a model for a line. */
export async function reserveForLine(orgId: string, userId: string, ref: LineRef, partId: string, qty: number, reason: string | null) {
  const db = await tenant(orgId);
  return reserveAllocation(db as never, orgId, userId, {
    part_id: partId,
    qty,
    target_module: ref.targetModule,
    target_entity_type: ref.targetType,
    target_entity_id: ref.targetId,
    target_line: ref.line,
    reason,
  });
}

/** Open one unit of a model for a line: the child at full capacity, its
 *  opening statement line, the instance-of link, the model's count down by
 *  one, and the binding. The same steps the per-unit panel's "Open a ball"
 *  takes, done on the server so a pattern can do it when it is finished. */
async function openUnitForLine(
  orgId: string,
  userId: string,
  ref: LineRef,
  model: { id: string; name: string; instance: string; metadata: unknown; unit: string | null },
  capacity: number,
  unit: string | null,
  reason: string,
): Promise<{ unitId: string; allocationId: string } | null> {
  const db = await tenant(orgId);
  const noun = model.unit || "unit";
  const child = await db
    .insertInto("inventory_parts")
    .values({
      name: `${model.name} (open ${noun})`,
      unit: unit || "unit",
      qty: "0",
      archived: true,
      instance: model.instance,
      metadata: sql`${JSON.stringify({ [UNIT_OF_KEY]: model.id, unit_state: "open", capacity })}::jsonb`,
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  await applyStockDelta(orgId, { partId: child.id, delta: capacity, reason: `Opened ${noun}` });
  await platform()
    .pairings.create({
      orgId,
      sourceKind: "inventory:part",
      sourceId: child.id,
      targetKind: "inventory:part",
      targetId: model.id,
      relationshipKind: "instance-of",
      createdBy: userId || null,
    })
    .catch(() => undefined);
  const took = await applyStockDelta(orgId, { partId: model.id, delta: -1, reason: `Opened a ${noun} for ${reason}` });
  if (!took.ok) return null;
  const r = await reserveForLine(orgId, userId, ref, child.id, capacity, reason);
  if (!r.ok) return null;
  return { unitId: child.id, allocationId: String(r.row.id) };
}

export interface UseResult {
  ok: true;
  /** What was taken, ball by ball. */
  took: { part_id: string; part_name: string; amount: number; left: number }[];
  /** What the stash could not cover. */
  short: number;
  unit: string | null;
}

/**
 * Take `amount` of a model for a line: measured (metres) when the model has a
 * per-unit capacity, else whole units. The line's own bound balls first, then
 * open partials of the same model nobody has bound (reach for a half-ball
 * before a new one, consumption-ledger.md §2), then fresh units. Each take is
 * a ledger line on the ball it came from, attributed to the line's binding.
 */
export async function useForLine(
  orgId: string,
  userId: string,
  ref: LineRef,
  partId: string,
  amount: { measure?: number; units?: number },
  reason: string,
): Promise<UseResult | { ok: false; error: string }> {
  const db = await tenant(orgId);
  const model = await db
    .selectFrom("inventory_parts")
    .select(["id", "name", "instance", "metadata", "unit", "qty"])
    .where("id", "=", partId)
    .executeTakeFirst();
  if (!model) return { ok: false, error: "that yarn no longer exists" };
  const { capacity, unit } = await unitCapacity(orgId, model);
  const took: UseResult["took"] = [];

  if (amount.measure == null || capacity == null) {
    // Whole units off the model, against the line's reservation when there is one.
    const n = amount.units ?? (amount.measure != null && capacity ? Math.ceil(amount.measure / capacity) : 0);
    if (!(n > 0)) return { ok: true, took, short: 0, unit: model.unit };
    const held = (await lineAllocations(db, ref, ["reserved"])).find((a) => a.part_id === partId && !a.unit_of);
    const r = await applyStockDelta(orgId, {
      partId,
      delta: -n,
      reason,
      sourceKind: held ? "allocation" : null,
      sourceId: held?.id ?? null,
    });
    const moved = r.ok ? -Number(r.delta ?? 0) : 0;
    took.push({ part_id: partId, part_name: model.name, amount: moved, left: Number(r.newQty ?? 0) });
    return { ok: true, took, short: Math.max(0, n - moved), unit: model.unit };
  }

  let left = amount.measure;
  const take = async (unitId: string, name: string, have: number, allocationId: string) => {
    const want = Math.min(left, have);
    if (!(want > 0)) return;
    const r = await applyStockDelta(orgId, { partId: unitId, delta: -want, reason, sourceKind: "allocation", sourceId: allocationId });
    if (!r.ok) return;
    const moved = -Number(r.delta ?? 0);
    left = Math.max(0, left - moved);
    took.push({ part_id: unitId, part_name: name, amount: moved, left: Number(r.newQty ?? 0) });
  };

  // 1. The line's own balls of this yarn.
  for (const a of await lineAllocations(db, ref, ["reserved"])) {
    if (left <= 0) break;
    if (a.unit_of !== partId) continue;
    await take(a.part_id, a.part_name, Number(a.part_qty), a.id);
  }
  // 2. Open partials of this yarn that no one holds: bind, then take.
  if (left > 0) {
    const partials = await db
      .selectFrom("inventory_parts as u")
      .select(["u.id", "u.name", "u.qty"])
      .where(sql<boolean>`u.metadata->>${UNIT_OF_KEY} = ${partId}`)
      .where(sql<boolean>`u.qty > 0`)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom("inventory_allocations as b").select("b.id").whereRef("b.part_id", "=", "u.id").where("b.status", "=", "reserved"))),
      )
      .orderBy("u.qty", "asc")
      .execute();
    for (const p of partials) {
      if (left <= 0) break;
      const r = await reserveForLine(orgId, userId, ref, p.id, Number(p.qty), reason);
      if (r.ok) await take(p.id, p.name, Number(p.qty), String(r.row.id));
    }
  }
  // 3. Fresh units, one at a time, while the model has any.
  while (left > 0) {
    const fresh = await db.selectFrom("inventory_parts").select("qty").where("id", "=", partId).executeTakeFirst();
    if (!fresh || Number(fresh.qty) < 1) break;
    const opened = await openUnitForLine(orgId, userId, ref, model, capacity, unit, reason);
    if (!opened) break;
    await take(opened.unitId, `${model.name} (open ${model.unit || "unit"})`, capacity, opened.allocationId);
  }
  return { ok: true, took, short: Math.round(left * 100) / 100, unit };
}

/**
 * Let a line go. Reservations of unopened units are released (stock never
 * moved for them). Balls bound to the line leave it: an empty one is marked
 * consumed, one with something left goes back to the pool as an open partial,
 * which is what keeping a half-ball means (§1.1). Nothing is un-used.
 */
export async function releaseLine(orgId: string, ref: LineRef): Promise<{ released: number; kept: { part_id: string; left: number }[] }> {
  const db = await tenant(orgId);
  const held = await lineAllocations(db, ref, ["reserved"]);
  const kept: { part_id: string; left: number }[] = [];
  for (const a of held) {
    const empty = a.unit_of != null && Number(a.part_qty) <= 0;
    await db
      .updateTable("inventory_allocations")
      .set(empty ? { status: "consumed", consumed_at: new Date() } : { status: "released", released_at: new Date() })
      .where("id", "=", a.id)
      .execute();
    if (a.unit_of && !empty) kept.push({ part_id: a.part_id, left: Number(a.part_qty) });
  }
  if (held.length) platform().events.emit("inventory.stock.changed", { orgId, partId: held[0]!.unit_of ?? held[0]!.part_id, delta: 0 });
  return { released: held.length, kept };
}

/**
 * A target finished or abandoned: settle what was reserved for it as a whole
 * (no line). Finished uses up a reservation of unopened units; abandoned
 * returns it. A ball bound to the target is only ever RELEASED: its use was
 * logged metre by metre as it happened, and consuming the binding as well
 * took the same yarn off twice. Lines are the caller's to settle (use-for-line
 * then release-line), so they are left alone here.
 */
export async function settleTarget(
  orgId: string,
  userId: string,
  target: Omit<LineRef, "line">,
  outcome: "done" | "abandoned",
): Promise<{ consumed: number; released: number }> {
  const db = await tenant(orgId);
  const held = await db
    .selectFrom("inventory_allocations as a")
    .innerJoin("inventory_parts as p", "p.id", "a.part_id")
    .select(["a.id", sql<string | null>`p.metadata->>${UNIT_OF_KEY}`.as("unit_of")])
    // By module and id only: reservations made from a pattern's page before
    // lines existed carry the type as "projects:project", later ones "project".
    .where("a.target_module", "=", target.targetModule)
    .where("a.target_entity_id", "=", target.targetId)
    .where("a.target_line", "is", null)
    .where("a.status", "=", "reserved")
    .execute();
  let consumed = 0;
  let released = 0;
  for (const a of held) {
    const status = outcome === "done" && !a.unit_of ? "consumed" : "released";
    const r = await settleAllocation(db as never, orgId, userId, a.id, status);
    if (r.ok) status === "consumed" ? consumed++ : released++;
  }
  return { consumed, released };
}

function refOf(args: Record<string, unknown>): LineRef | null {
  const kind = typeof args.for_kind === "string" ? args.for_kind.trim() : "";
  const id = typeof args.for_id === "string" ? args.for_id.trim() : "";
  const line = typeof args.for_line === "string" ? args.for_line.trim() : "";
  if (!kind.includes(":") || !id) return null;
  const [targetModule, targetType] = [kind.split(":")[0]!, kind.split(":")[1]!];
  return { targetModule, targetType, targetId: id, line };
}

/** The handlers the projects module (or any consumer of lines) invokes. Not
 *  offered to the assistant as actions of their own: a pattern's lines are
 *  driven by the pattern (its yarn picked, its status set to done). */
export function registerTargetLineHandlers(): void {
  platform().actions.registerHandler("inventory.reserve-for-line", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const ref = refOf(a);
    const partId = typeof a.part_id === "string" ? a.part_id : "";
    const qty = Number(a.qty);
    if (!ref?.line || !partId || !(qty > 0)) return { ok: false, error: "say the part, a positive qty, and for_kind / for_id / for_line" };
    const r = await reserveForLine(ctx.orgId, ctx.userId ?? "", ref, partId, qty, typeof a.reason === "string" ? a.reason : null);
    return r.ok ? { ok: true, allocation_id: r.row.id } : { ok: false, error: "that part no longer exists" };
  });
  platform().actions.registerHandler("inventory.line-usage", async (ctx) => {
    const ref = refOf((ctx.args ?? {}) as Record<string, unknown>);
    if (!ref) return { ok: false, error: "say for_kind and for_id" };
    return { ok: true, lines: await lineUsage(ctx.orgId, ref) };
  });
  platform().actions.registerHandler("inventory.use-for-line", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const ref = refOf(a);
    const partId = typeof a.part_id === "string" ? a.part_id : "";
    if (!ref?.line || !partId) return { ok: false, error: "say the part and for_kind / for_id / for_line" };
    const measure = num(a.measure);
    const units = num(a.units);
    return useForLine(ctx.orgId, ctx.userId ?? "", ref, partId, { ...(measure != null ? { measure } : {}), ...(units != null ? { units } : {}) }, typeof a.reason === "string" && a.reason ? a.reason : "Used");
  });
  platform().actions.registerHandler("inventory.settle-target", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const ref = refOf(a);
    const outcome = a.outcome === "abandoned" ? "abandoned" : a.outcome === "done" ? "done" : null;
    if (!ref || !outcome) return { ok: false, error: "say for_kind / for_id and outcome done or abandoned" };
    return { ok: true, ...(await settleTarget(ctx.orgId, ctx.userId ?? "", ref, outcome)) };
  });
  platform().actions.registerHandler("inventory.release-line", async (ctx) => {
    const ref = refOf((ctx.args ?? {}) as Record<string, unknown>);
    if (!ref?.line) return { ok: false, error: "say for_kind / for_id / for_line" };
    return { ok: true, ...(await releaseLine(ctx.orgId, ref)) };
  });
}
