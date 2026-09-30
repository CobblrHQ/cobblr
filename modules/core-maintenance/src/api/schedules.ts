// /api/v1/orgs/:slug/modules/core-maintenance/schedules (#3876)
//
// "Service every 3 months", "every 200 print hours": how often a record wants
// servicing. Each schedule keeps one open occurrence in the service log (a
// scheduled entry carrying schedule_id); see schedules-store.ts.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, type CoreMaintenanceDB } from "../db.js";
import type { Kysely } from "kysely";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { counterDefs, dueOf, ensureOccurrence, readCounter, type ScheduleRow } from "../schedules-store.js";
import { INTERVAL_UNITS, describeRule, hasCalendar, hasCounter } from "../schedule.js";
import { sql } from "kysely";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";

export const schedulesRouter = Router({ mergeParams: true });

const Rule = {
  name: z.string().trim().min(1).max(200),
  every_n: z.number().int().positive().max(1000).nullable().optional(),
  every_unit: z.enum(INTERVAL_UNITS as unknown as [string, ...string[]]).nullable().optional(),
  counter_field: z.string().min(1).max(80).nullable().optional(),
  counter_every: z.number().positive().max(10_000_000).nullable().optional(),
  /** When it was last done, if before today: the first due date counts from it. */
  last_done_at: z.string().nullable().optional(),
};

const ScheduleCreate = z
  .object({
    entity_module: z.string().min(1).max(80),
    entity_type: z.string().min(1).max(80),
    entity_id: z.string().uuid(),
    ...Rule,
  })
  .refine((d) => (d.every_n && d.every_unit) || (d.counter_field && d.counter_every), {
    message: "A schedule needs a calendar interval (every_n + every_unit) or a counter interval (counter_field + counter_every)",
    path: ["every_n"],
  });

const ScheduleUpdate = z.object({
  name: Rule.name.optional(),
  every_n: Rule.every_n,
  every_unit: Rule.every_unit,
  counter_field: Rule.counter_field,
  counter_every: Rule.counter_every,
  last_done_at: Rule.last_done_at,
});

/** A schedule as a record page shows it: the rule in words and where it stands. */
export async function present(orgId: string, s: ScheduleRow, timeZone?: string | null) {
  const due = await dueOf(orgId, s, new Date(), timeZone);
  return {
    ...s,
    counter_every: s.counter_every == null ? null : Number(s.counter_every),
    last_done_counter: s.last_done_counter == null ? null : Number(s.last_done_counter),
    rule: describeRule({ every_n: s.every_n, every_unit: s.every_unit, counter_field: s.counter_field, counter_every: s.counter_every == null ? null : Number(s.counter_every) }, due.counter_label),
    due: {
      state: due.state,
      reason: due.reason,
      next_due_at: due.next_due_at,
      next_due_counter: due.next_due_counter,
      counter: due.counter,
      counter_label: due.counter_label,
    },
  };
}

function when(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Create one, stamping the counter reading it starts from, and make its
 *  first occurrence. Shared by the route and the action. */
export async function createSchedule(
  db: Kysely<CoreMaintenanceDB>,
  orgId: string,
  d: z.infer<typeof ScheduleCreate>,
): Promise<ScheduleRow> {
  const kind = `${d.entity_module}:${d.entity_type}`;
  const reading = d.counter_field ? await readCounter(orgId, kind, d.entity_id, d.counter_field) : null;
  const row = await db
    .insertInto("core_maintenance_schedules")
    .values({
      entity_module: d.entity_module,
      entity_type: d.entity_type,
      entity_id: d.entity_id,
      name: d.name,
      every_n: d.every_n && d.every_unit ? d.every_n : null,
      every_unit: d.every_n && d.every_unit ? (d.every_unit as ScheduleRow["every_unit"]) : null,
      counter_field: d.counter_field && d.counter_every ? d.counter_field : null,
      counter_every: d.counter_field && d.counter_every ? d.counter_every : null,
      last_done_at: when(d.last_done_at),
      last_done_counter: reading,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ensureOccurrence(db, orgId, row);
  return row;
}

export const ScheduleCreateBody = ScheduleCreate;

// AI-REACH: exempt a read; a record's schedules reach the assistant as the due occurrences list_maintenance reads; setting one is core-maintenance:schedule
schedulesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = z
      .object({
        entity_module: z.string().optional(),
        entity_type: z.string().optional(),
        entity_id: z.string().uuid().optional(),
        /** The reader's zone, so "overdue by N days" counts their days. */
        tz: z.string().max(64).optional(),
      })
      .safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const ctx = tenantContext(req);
    let query = tenantDb(req).selectFrom("core_maintenance_schedules").selectAll();
    if (q.data.entity_module) query = query.where("entity_module", "=", q.data.entity_module);
    if (q.data.entity_type) query = query.where("entity_type", "=", q.data.entity_type);
    if (q.data.entity_id) query = query.where("entity_id", "=", q.data.entity_id);
    const page = readListPage(req.query, 200);
    const rows = await query
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .orderBy("created_at", "asc")
      .orderBy("id")
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const answer = pagedAnswer(rows, page);
    res.json({ ...answer, items: await Promise.all(answer.items.map((r) => present(ctx.org.id, r, q.data.tz ?? null))) });
  }),
);

// AI-REACH: exempt a read for the schedule form (which counters a record keeps); the assistant sets schedules through core-maintenance:schedule
schedulesRouter.get(
  "/counters",
  asyncHandler(async (req, res) => {
    const q = z.object({ kind: z.string().min(1), entity_id: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const ctx = tenantContext(req);
    const defs = await counterDefs(ctx.org.id, q.data.kind);
    const values: Record<string, number | null> = {};
    if (q.data.entity_id) for (const d of defs) values[d.key] = await readCounter(ctx.org.id, q.data.kind, q.data.entity_id, d.key);
    res.json({ counters: defs.map((d) => ({ ...d, value: values[d.key] ?? null })) });
  }),
);

// AI-REACH: action core-maintenance:schedule
schedulesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ScheduleCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const row = await createSchedule(tenantDb(req), ctx.org.id, parsed.data);
    void platform().events.emit("core-maintenance.schedule.created", { orgId: ctx.org.id, scheduleId: row.id, entityId: row.entity_id });
    res.status(201).json(await present(ctx.org.id, row));
  }),
);

// AI-REACH: exempt editing a schedule's rule is a form edit on the record; the assistant sets a new one through core-maintenance:schedule
schedulesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ScheduleUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = String(req.params.id ?? "");
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const before = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", id).executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
      return;
    }
    const d = parsed.data;
    const next = {
      name: d.name ?? before.name,
      every_n: d.every_n !== undefined ? d.every_n : before.every_n,
      every_unit: (d.every_unit !== undefined ? d.every_unit : before.every_unit) as ScheduleRow["every_unit"],
      counter_field: d.counter_field !== undefined ? d.counter_field : before.counter_field,
      counter_every: d.counter_every !== undefined ? d.counter_every : before.counter_every == null ? null : Number(before.counter_every),
    };
    if (!hasCalendar(next) && !hasCounter(next)) {
      res.status(400).json({ error: { code: "invalid_body", message: "A schedule needs a calendar interval or a counter interval" } });
      return;
    }
    const counterChanged = next.counter_field !== before.counter_field;
    const reading = counterChanged && next.counter_field
      ? await readCounter(ctx.org.id, `${before.entity_module}:${before.entity_type}`, before.entity_id, next.counter_field)
      : undefined;
    const row = await db
      .updateTable("core_maintenance_schedules")
      .set({
        ...next,
        ...(d.last_done_at !== undefined ? { last_done_at: when(d.last_done_at) } : {}),
        ...(reading !== undefined ? { last_done_counter: reading } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // The rule moved, so the open occurrence's date may have: make it again.
    await db.deleteFrom("core_maintenance_entries").where("schedule_id", "=", id).where("performed_at", "is", null).execute();
    await ensureOccurrence(db, ctx.org.id, row);
    res.json(await present(ctx.org.id, row));
  }),
);

// AI-REACH: exempt removing a schedule is a person's call on the record; the assistant sets one, and its undo removes it
schedulesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = String(req.params.id ?? "");
    const db = tenantDb(req);
    const row = await db.deleteFrom("core_maintenance_schedules").where("id", "=", id).returning(["id"]).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
      return;
    }
    // Its open occurrence goes with it; the history it rolled stays.
    await db.deleteFrom("core_maintenance_entries").where("schedule_id", "=", id).where("performed_at", "is", null).execute();
    res.status(204).end();
  }),
);
