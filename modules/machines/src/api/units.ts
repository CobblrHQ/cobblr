// One machine record can stand for N identical machines (quantity), and any of
// the N can be given an identity of its own under it: a UNIT, a machine record
// of the same collection paired `unit-of` to its parent. A unit keeps its own
// name, state, notes, location, service log, label and links, and never shows
// as a record of its own in the list; it is one of the parent's N.
//
// The rules, each deliberate (docs/design-decisions/holdings-and-units.md,
// phase 5):
//   - naming a unit happens INSIDE the count: the parent's quantity is untouched
//     and no more units can be named than it counts;
//   - "split into its own" unpairs a unit (or makes a new record for one not
//     yet named) and takes one off the parent's quantity;
//   - "make it a unit of" pairs a single machine to a parent and adds one;
//   - deleting a parent leaves its units as records of their own.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { UNIT_OF } from "@cobblr/platform-contract/holdings";
import type { MachinesDB } from "../db.js";

export const MACHINE_KIND = "machines:machine";

export type UnitsCtx = { db: Kysely<MachinesDB>; orgId: string; userId: string | null; instance: string };

export type Refusal = { status: number; error: { code: string; message: string } };
export const isRefusal = (x: unknown): x is Refusal => !!x && typeof x === "object" && "error" in x && "status" in x;

/** What a new record for one of the N copies from its parent: what the machine
 *  IS. Never its usage counters (those are that record's own history). */
const IDENTITY = ["short_name", "family", "type", "manufacturer", "state", "image_path", "location_id"] as const;
const OWN_HISTORY = new Set(["print_count", "print_hours", "run_hours"]);

export async function unitsCtxFor(orgId: string, userId: string | null, machineId: string): Promise<UnitsCtx | null> {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<MachinesDB>;
  const row = await db.selectFrom("machines_machines").select("instance").where("id", "=", machineId).executeTakeFirst();
  return row ? { db, orgId, userId, instance: row.instance } : null;
}

/** parent id → the ids of its named units. */
export async function unitsOf(orgId: string, parentIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!parentIds.length) return out;
  const pairs = await platform().pairings.findByTargets({ orgId, sourceKind: MACHINE_KIND, targetKind: MACHINE_KIND, targetIds: parentIds, relationshipKind: UNIT_OF });
  for (const p of pairs) out.set(p.targetId, [...(out.get(p.targetId) ?? []), p.sourceId]);
  return out;
}

/** unit id → its parent's id. */
export async function parentsOf(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const pairs = await platform().pairings.findBySources({ orgId, sourceKind: MACHINE_KIND, sourceIds: ids, targetKind: MACHINE_KIND, relationshipKind: UNIT_OF });
  for (const p of pairs) out.set(p.sourceId, p.targetId);
  return out;
}

/** Every named unit in one collection. Pairings live apart from the machines
 *  table, so a list excludes these by id in its own query: dropping them from
 *  a fetched page instead would shorten the page, and a reader that pages
 *  until a short page would stop counting early. */
export async function unitIdsIn(db: Kysely<MachinesDB>, orgId: string, instance: string): Promise<string[]> {
  const ids = (await db.selectFrom("machines_machines").select("id").where("instance", "=", instance).execute()).map((r) => r.id);
  return [...(await parentsOf(orgId, ids)).keys()];
}

export type UnitRow = { id: string; name: string; state: string; location_id: string | null; serial_number: string | null; image_path: string | null };

/** A list page as a person reads it: a unit is not a record of its own, so it
 *  leaves the page and its parent carries it (`units`, the named ones; the
 *  rest of `quantity` are not named yet). */
export async function liftUnits<T extends { id: string }>(db: Kysely<MachinesDB>, orgId: string, rows: T[]): Promise<Array<T & { units: UnitRow[] }>> {
  const ids = rows.map((r) => r.id);
  const parents = await parentsOf(orgId, ids);
  const top = rows.filter((r) => !parents.has(r.id));
  const named = await unitsOf(orgId, top.map((r) => r.id));
  const unitIds = [...named.values()].flat();
  const unitRows = unitIds.length
    ? await db.selectFrom("machines_machines").select(["id", "name", "state", "location_id", "serial_number", "image_path"]).where("id", "in", unitIds).orderBy("created_at").execute()
    : [];
  const byId = new Map(unitRows.map((u) => [u.id, u as UnitRow]));
  return top.map((r) => ({ ...r, units: (named.get(r.id) ?? []).map((id) => byId.get(id)).filter((u): u is UnitRow => !!u) }));
}

async function load(c: UnitsCtx, id: string) {
  return c.db.selectFrom("machines_machines").selectAll().where("id", "=", id).where("instance", "=", c.instance).executeTakeFirst();
}

async function log(c: UnitsCtx, action: string, id: string, diff: Record<string, unknown>) {
  await platform().activity.log({ orgId: c.orgId, userId: c.userId ?? undefined, action, ref: { module: "machines", entityType: "machine", entityId: id }, diff } as never);
}

/** Everything a person reads about a machine's units: the named ones, how many
 *  of the N are not named yet, and, on a unit, which machine it is one of. */
export async function unitsSummary(c: UnitsCtx, id: string) {
  const row = await load(c, id);
  if (!row) return null;
  const parentId = (await parentsOf(c.orgId, [id])).get(id) ?? null;
  const parent = parentId ? await c.db.selectFrom("machines_machines").select(["id", "name", "quantity"]).where("id", "=", parentId).executeTakeFirst() : null;
  const named = (await unitsOf(c.orgId, [id])).get(id) ?? [];
  const units = named.length
    ? await c.db.selectFrom("machines_machines").select(["id", "name", "state", "location_id", "serial_number", "image_path"]).where("id", "in", named).orderBy("created_at").execute()
    : [];
  const quantity = Number(row.quantity ?? 1);
  return {
    id,
    quantity,
    units: units as UnitRow[],
    not_named: Math.max(quantity - units.length, 0),
    unit_of: parent ? { id: parent.id, name: parent.name } : null,
  };
}

/** Give one of the N an identity of its own, under the parent. Inside the
 *  count: the quantity stays, and a record cannot have more named units than
 *  it counts. */
export async function nameUnit(c: UnitsCtx, parentId: string, input: { name?: string | null; serial_number?: string | null }): Promise<{ id: string; parent_id: string } | Refusal> {
  const parent = await load(c, parentId);
  if (!parent) return { status: 404, error: { code: "not_found", message: "machine not found" } };
  if ((await parentsOf(c.orgId, [parentId])).has(parentId)) return { status: 409, error: { code: "is_a_unit", message: "This is already one unit of another machine." } };
  const named = (await unitsOf(c.orgId, [parentId])).get(parentId) ?? [];
  const quantity = Number(parent.quantity ?? 1);
  if (named.length >= quantity) {
    return { status: 409, error: { code: "all_units_named", message: `All ${quantity} already have a name of their own. Change the quantity first if there are more.` } };
  }
  const id = await insertCopy(c, parent, input.name?.trim() || `${parent.name} · unit ${named.length + 1}`, input.serial_number ?? null);
  await platform().pairings.create({ orgId: c.orgId, sourceKind: MACHINE_KIND, sourceId: id, targetKind: MACHINE_KIND, targetId: parentId, relationshipKind: UNIT_OF, createdBy: c.userId });
  await log(c, "machine_unit_named", parentId, { unit_id: id });
  return { id, parent_id: parentId };
}

async function insertCopy(c: UnitsCtx, from: Record<string, unknown> & { instance: string }, name: string, serial: string | null): Promise<string> {
  const meta = Object.fromEntries(Object.entries((from.metadata ?? {}) as Record<string, unknown>).filter(([k]) => !OWN_HISTORY.has(k)));
  const values: Record<string, unknown> = { name, quantity: 1, instance: from.instance, metadata: meta, serial_number: serial };
  for (const k of IDENTITY) values[k] = from[k] ?? null;
  if (values.state == null) delete values.state;
  const row = await c.db.insertInto("machines_machines").values(values as never).returning("id").executeTakeFirstOrThrow();
  if (values.location_id) {
    await platform()
      .placement.place({ orgId: c.orgId, containee: { kind: MACHINE_KIND, id: row.id }, container: { kind: "core-locations:location", id: String(values.location_id) } })
      .catch(() => undefined);
  }
  platform().events.emit("machines.machine.created", { orgId: c.orgId, machineId: row.id });
  return row.id;
}

async function addToQuantity(c: UnitsCtx, id: string, by: number): Promise<number> {
  const row = await c.db
    .updateTable("machines_machines")
    .set((eb) => ({ quantity: eb("quantity", "+", by), updated_at: new Date() }) as never)
    .where("id", "=", id)
    .returning("quantity")
    .executeTakeFirstOrThrow();
  return Number(row.quantity);
}

/** A named unit becomes a machine record of its own. It keeps everything it
 *  already had (it always was a record); the parent counts one fewer. */
export async function splitUnit(c: UnitsCtx, unitId: string): Promise<{ id: string; parent_id: string; parent_quantity: number } | Refusal> {
  const parentId = (await parentsOf(c.orgId, [unitId])).get(unitId);
  if (!parentId) return { status: 409, error: { code: "not_a_unit", message: "This machine is not a unit of another one." } };
  await platform().pairings.remove({ orgId: c.orgId, sourceKind: MACHINE_KIND, sourceId: unitId, targetKind: MACHINE_KIND, targetId: parentId, relationshipKind: UNIT_OF });
  const parent_quantity = await addToQuantity(c, parentId, -1);
  await log(c, "machine_unit_split", unitId, { from: parentId });
  return { id: unitId, parent_id: parentId, parent_quantity };
}

/** One of the N that has no name yet leaves as a new record of its own. */
export async function splitOne(c: UnitsCtx, parentId: string, input: { name?: string | null }): Promise<{ id: string; parent_id: string; parent_quantity: number } | Refusal> {
  const s = await unitsSummary(c, parentId);
  if (!s) return { status: 404, error: { code: "not_found", message: "machine not found" } };
  if (s.not_named < 1 || s.quantity < 2) {
    return { status: 409, error: { code: "none_to_split", message: s.units.length ? "Every one of these has a name: split one of the named units instead." : "This record stands for one machine; there is nothing to split off." } };
  }
  const parent = (await load(c, parentId))!;
  const id = await insertCopy(c, parent, input.name?.trim() || parent.name, null);
  const parent_quantity = await addToQuantity(c, parentId, -1);
  await log(c, "machine_unit_split", id, { from: parentId });
  return { id, parent_id: parentId, parent_quantity };
}

/** A single machine becomes one unit of another record in the same collection:
 *  the parent counts one more. */
export async function mergeInto(c: UnitsCtx, id: string, parentId: string): Promise<{ id: string; parent_id: string; parent_quantity: number } | Refusal> {
  if (id === parentId) return { status: 409, error: { code: "same_machine", message: "A machine cannot be a unit of itself." } };
  const [row, parent] = await Promise.all([load(c, id), load(c, parentId)]);
  if (!row || !parent) return { status: 404, error: { code: "not_found", message: "Both machines must be in this collection." } };
  if (Number(row.quantity ?? 1) !== 1) return { status: 409, error: { code: "not_one_machine", message: `This record counts ${row.quantity}; only a single machine can become a unit.` } };
  if ((await unitsOf(c.orgId, [id])).get(id)?.length) return { status: 409, error: { code: "has_units", message: "This machine has units of its own." } };
  const parents = await parentsOf(c.orgId, [id, parentId]);
  if (parents.has(parentId)) return { status: 409, error: { code: "is_a_unit", message: "That machine is itself a unit of another one." } };
  const current = parents.get(id);
  if (current === parentId) return { status: 409, error: { code: "already_a_unit", message: "It is already a unit of that machine." } };
  if (current) await splitUnit(c, id);
  await platform().pairings.create({ orgId: c.orgId, sourceKind: MACHINE_KIND, sourceId: id, targetKind: MACHINE_KIND, targetId: parentId, relationshipKind: UNIT_OF, createdBy: c.userId });
  const parent_quantity = await addToQuantity(c, parentId, 1);
  await log(c, "machine_unit_merged", id, { into: parentId });
  return { id, parent_id: parentId, parent_quantity };
}

/** Before a machine record is deleted: its units become records of their own,
 *  and a unit leaving by deletion takes one off its parent's count. */
export async function releaseForDelete(c: UnitsCtx, id: string): Promise<void> {
  for (const unit of (await unitsOf(c.orgId, [id])).get(id) ?? []) {
    await platform().pairings.remove({ orgId: c.orgId, sourceKind: MACHINE_KIND, sourceId: unit, targetKind: MACHINE_KIND, targetId: id, relationshipKind: UNIT_OF });
  }
  const parent = (await parentsOf(c.orgId, [id])).get(id);
  if (parent) {
    await platform().pairings.remove({ orgId: c.orgId, sourceKind: MACHINE_KIND, sourceId: id, targetKind: MACHINE_KIND, targetId: parent, relationshipKind: UNIT_OF });
    await addToQuantity(c, parent, -1);
  }
}
