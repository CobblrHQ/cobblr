// What a person changes inside a build: its components, its steps (the
// routing), what is logged at a step, and its planned runs. One body each,
// shared by the HTTP routes (builds.ts) and the record actions on a build
// (the *-action.ts files beside this), so a press and an assistant's call
// cannot mean two different things.

import { platform, ActionRefusal } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";

type Db = Kysely<BuildsDB>;

export interface ComponentInput {
  part_id?: string;
  sub_assembly_build_id?: string;
  quantity: number;
  optional?: boolean;
  use_stock?: boolean;
  /** A part line: back to stock when a print is scrapped after it ran (#8758). */
  recoverable?: boolean;
  notes?: string | null;
}

/** Add a component, refusing a build that would contain itself. */
export async function addComponent(db: Db, buildId: string, c: ComponentInput) {
  if (c.sub_assembly_build_id) {
    if (c.sub_assembly_build_id === buildId) throw new ActionRefusal("A build can't be its own sub-assembly.");
    const sub = await db.selectFrom("builds_builds").select(["id"]).where("id", "=", c.sub_assembly_build_id).executeTakeFirst();
    if (!sub) throw new ActionRefusal("That sub-assembly build is not here.");
  }
  return db
    .insertInto("builds_components")
    .values({
      build_id: buildId,
      part_id: c.part_id ?? null,
      sub_assembly_build_id: c.sub_assembly_build_id ?? null,
      quantity: String(c.quantity),
      optional: c.optional ?? false,
      use_stock: c.use_stock ?? true,
      recoverable: c.recoverable ?? false,
      notes: c.notes ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function removeComponent(db: Db, buildId: string, componentId: string) {
  return (await db.deleteFrom("builds_components").where("id", "=", componentId).where("build_id", "=", buildId).returningAll().executeTakeFirst()) ?? null;
}

export interface StepInput {
  name: string;
  description?: string | null;
  est_minutes?: number | null;
  resource_module?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
}

/** Append a step at the end of the routing. */
export async function addStep(db: Db, orgId: string, buildId: string, s: StepInput) {
  const max = await db
    .selectFrom("builds_operations")
    .select(({ fn }) => [fn.max<number>("seq").as("m")])
    .where("build_id", "=", buildId)
    .executeTakeFirst();
  const row = await db
    .insertInto("builds_operations")
    .values({
      build_id: buildId,
      seq: (Number(max?.m) || 0) + 1,
      name: s.name.trim(),
      description: s.description ?? null,
      est_minutes: s.est_minutes != null ? String(s.est_minutes) : null,
      resource_module: s.resource_module ?? null,
      resource_type: s.resource_type ?? null,
      resource_id: s.resource_id ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await platform().events.emit("builds.operation.created", { orgId, buildId, operationId: row.id, name: row.name });
  return row;
}

export interface StepChange {
  name?: string;
  description?: string | null;
  status?: "todo" | "doing" | "done" | "skipped";
  seq?: number;
  est_minutes?: number | null;
  resource_module?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  notes?: string | null;
}

/** Change a step; a step crossing into done fires the wireable event. */
export async function changeStep(db: Db, orgId: string, buildId: string, opId: string, c: StepChange) {
  const before = await db.selectFrom("builds_operations").selectAll().where("id", "=", opId).where("build_id", "=", buildId).executeTakeFirst();
  if (!before) return null;
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (c.name !== undefined) patch.name = c.name.trim();
  if (c.description !== undefined) patch.description = c.description;
  if (c.status !== undefined) patch.status = c.status;
  if (c.seq !== undefined) patch.seq = c.seq;
  if (c.est_minutes !== undefined) patch.est_minutes = c.est_minutes != null ? String(c.est_minutes) : null;
  if (c.resource_module !== undefined) patch.resource_module = c.resource_module;
  if (c.resource_type !== undefined) patch.resource_type = c.resource_type;
  if (c.resource_id !== undefined) patch.resource_id = c.resource_id;
  if (c.notes !== undefined) patch.notes = c.notes;
  const row = await db.updateTable("builds_operations").set(patch).where("id", "=", opId).where("build_id", "=", buildId).returningAll().executeTakeFirstOrThrow();
  if (c.status === "done" && before.status !== "done") {
    await platform().events.emit("builds.operation.completed", { orgId, buildId, operationId: opId, name: row.name });
  }
  return { before, row };
}

export async function removeStep(db: Db, buildId: string, opId: string) {
  return (await db.deleteFrom("builds_operations").where("id", "=", opId).where("build_id", "=", buildId).returning(["id", "name"]).executeTakeFirst()) ?? null;
}

export async function logStepTime(
  db: Db,
  orgId: string,
  buildId: string,
  op: { id: string },
  t: { kind?: "labor" | "machine" | "setup"; minutes: number; notes?: string | null },
  userId: string | null,
) {
  const row = await db
    .insertInto("builds_op_time")
    .values({ operation_id: op.id, build_id: buildId, kind: t.kind ?? "labor", minutes: String(t.minutes), notes: t.notes ?? null, logged_by: userId })
    .returningAll()
    .executeTakeFirstOrThrow();
  await platform().events.emit("builds.operation.time_logged", { orgId, buildId, operationId: op.id, kind: row.kind, minutes: Number(row.minutes) || 0 });
  return row;
}

export async function logStepCount(
  db: Db,
  orgId: string,
  buildId: string,
  op: { id: string; name: string },
  q: { kind: "good" | "scrap" | "rework"; quantity: number; reason?: string | null },
  userId: string | null,
) {
  const row = await db
    .insertInto("builds_op_qty")
    .values({ operation_id: op.id, build_id: buildId, kind: q.kind, quantity: String(q.quantity), reason: q.reason ?? null, logged_by: userId })
    .returningAll()
    .executeTakeFirstOrThrow();
  // Scrap is the wireable signal (e.g. → a notification, or a quality log later).
  if (row.kind === "scrap") {
    await platform().events.emit("builds.operation.scrapped", { orgId, buildId, operationId: op.id, operationName: op.name, quantity: Number(row.quantity) || 0, reason: row.reason });
  }
  return row;
}

export interface PlanInput {
  qty?: number;
  due_date?: string | null;
  priority?: number;
  resource_label?: string | null;
  notes?: string | null;
}

/** Plan a run of a build; a board revision plans through its assembly work order. */
export async function addPlannedBuild(db: Db, orgId: string, buildId: string, p: PlanInput) {
  const build = await db.selectFrom("builds_builds").select(["id", "metadata"]).where("id", "=", buildId).executeTakeFirst();
  if (!build) throw new ActionRefusal("That build is not here.");
  if ((build.metadata as { assembly?: unknown } | null)?.assembly) throw new ActionRefusal("Use the assembly work order action for a board revision.");
  const row = await db
    .insertInto("builds_planned")
    .values({ build_id: buildId, qty: String(p.qty ?? 1), due_date: p.due_date ?? null, priority: p.priority ?? 0, resource_label: p.resource_label ?? null, notes: p.notes ?? null })
    .returningAll()
    .executeTakeFirstOrThrow();
  await platform().events.emit("builds.planned.created", { orgId, plannedId: row.id, buildId: row.build_id });
  return row;
}

export interface PlanChange extends PlanInput {
  status?: "planned" | "done" | "cancelled";
}

export async function changePlan(db: Db, orgId: string, plannedId: string, c: PlanChange) {
  const before = await db.selectFrom("builds_planned").selectAll().where("id", "=", plannedId).executeTakeFirst();
  if (!before) return null;
  if (before.assembly) throw new ActionRefusal("Change this order through its assembly workflow.");
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (c.qty !== undefined) patch.qty = String(c.qty);
  if (c.due_date !== undefined) patch.due_date = c.due_date;
  if (c.priority !== undefined) patch.priority = c.priority;
  if (c.resource_label !== undefined) patch.resource_label = c.resource_label;
  if (c.status !== undefined) patch.status = c.status;
  if (c.notes !== undefined) patch.notes = c.notes;
  const row = await db.updateTable("builds_planned").set(patch).where("id", "=", plannedId).returningAll().executeTakeFirstOrThrow();
  if (c.status === "done" && before.status !== "done") {
    await platform().events.emit("builds.planned.completed", { orgId, plannedId: row.id, buildId: row.build_id });
  }
  return { before, row };
}

export async function removePlan(db: Db, plannedId: string) {
  const row = await db.selectFrom("builds_planned").select(["id", "assembly"]).where("id", "=", plannedId).executeTakeFirst();
  if (row?.assembly) throw new ActionRefusal("Cancel this order through its assembly workflow to release the kit.");
  await db.deleteFrom("builds_planned").where("id", "=", plannedId).execute();
  return !!row;
}

// ── finding what a person named, inside one build ──

export async function findStep(db: Db, buildId: string, named: unknown) {
  const want = typeof named === "string" ? named.trim() : "";
  const steps = await db.selectFrom("builds_operations").select(["id", "name", "seq", "status", "est_minutes", "notes"]).where("build_id", "=", buildId).orderBy("seq").execute();
  if (!want) return { error: steps.length ? `Say which step: ${steps.map((s) => s.name).join(", ")}.` : "This build has no steps yet." };
  const hit = steps.filter((s) => s.id === want || s.name.toLowerCase() === want.toLowerCase());
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) return { error: `More than one step is called "${want}"; say which by its id.` };
  return { error: steps.length ? `No step called "${want}". The steps are ${steps.map((s) => s.name).join(", ")}.` : "This build has no steps yet." };
}

export async function findPlan(db: Db, buildId: string, named: unknown) {
  const want = typeof named === "string" ? named.trim() : "";
  const open = await db.selectFrom("builds_planned").selectAll().where("build_id", "=", buildId).orderBy("created_at").execute();
  if (want) {
    const hit = open.find((p) => p.id === want);
    return hit ?? { error: "That planned run is not on this build." };
  }
  const planned = open.filter((p) => p.status === "planned");
  if (planned.length === 1) return planned[0]!;
  return { error: planned.length ? "This build has more than one planned run; say which by its id." : "This build has no planned run." };
}

/** The record an undo step runs on: the same build the action ran on. */
export function onBuild(uctx: { entity?: { kind: string; id: string } }): { entity_kind?: string; entity_id?: string } {
  return uctx.entity ? { entity_kind: uctx.entity.kind, entity_id: uctx.entity.id } : {};
}
