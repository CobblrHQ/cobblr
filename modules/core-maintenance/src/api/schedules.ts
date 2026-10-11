import { refreshBoundRenewal } from "../bound-renewal.js";
import { moneyForStorage, readMoney } from "@cobblr/platform-contract/money";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { MaintenanceRefusal } from "../refusal.js";
// /api/v1/orgs/:slug/modules/core-maintenance/schedules (#3876)
//
// "Service every 3 months", "every 200 print hours": how often a record wants
// servicing. Each schedule keeps one open occurrence in the service log (a
// scheduled entry carrying schedule_id); see schedules-store.ts.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, sessionUser, type CoreMaintenanceDB } from "../db.js";
import type { Kysely } from "kysely";
import { asyncHandler, badBody } from "./util.js";
import { counterDefs, dueOf, ensureOccurrence, readCounter, renewalState, writeExpiry, rollForward, type ScheduleRow } from "../schedules-store.js";
import { INTERVAL_UNITS, describeRule, hasCalendar, hasCounter, nextRenewalExpiry, nextReminderAt, cancelBy } from "../schedule.js";
import { sql } from "kysely";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { TermFields, termValues } from "../term-fields.js";

export const schedulesRouter = Router({ mergeParams: true });

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = new Date(v + "T12:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "Enter a valid date");
const Anchor = z.union([
  z.string().regex(/^\d{2}-\d{2}$/).refine((v) => DateOnly.safeParse("2000-" + v).success, "Enter a month and day"),
  z.object({ month: z.number().int().min(1).max(12), last_day: z.literal(true) }),
]);
const Remind = z.union([
  z.object({ before: z.number().int().min(0).max(3651), unit: z.enum(["day", "week", "month"]) }),
  z.object({ on: z.literal("month_start") }),
]);
const RenewalRule = {
  overdue_every: z.enum(["day", "week", "month", "off"]).nullable().optional(),
  anchor: Anchor.nullable().optional(),
  current_expiry: DateOnly.nullable().optional(),
  expiry_field: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80).nullable().optional(),
  remind: Remind.nullable().optional(),
};
const Rule = {
  ...RenewalRule,
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
  .refine((d) => (d.anchor && d.current_expiry && (!d.every_unit || INTERVAL_UNITS.includes(d.every_unit as never)) && !d.counter_field) || (!d.anchor && !d.expiry_field && ((d.every_n && d.every_unit) || (d.counter_field && d.counter_every))), {
    message: "A schedule needs a calendar interval (every_n + every_unit) or a counter interval (counter_field + counter_every)",
    path: ["every_n"],
  });

export const ScheduleUpdateBody = z.object({
  ...RenewalRule,
  name: Rule.name.optional(),
  every_n: Rule.every_n,
  every_unit: Rule.every_unit,
  counter_field: Rule.counter_field,
  counter_every: Rule.counter_every,
  last_done_at: Rule.last_done_at,
});

/** A schedule as a record page shows it: the rule in words and where it stands. */
export async function present(orgId: string, s: ScheduleRow, timeZone?: string | null) {
  const store = await platform().tenants.getDb(orgId) as Kysely<CoreMaintenanceDB>;
  s = await refreshBoundRenewal(store, orgId, s);
  const state = await renewalState(orgId, s);
  const due = await dueOf(orgId, s, new Date(), timeZone);
  const db = await platform().tenants.getDb(orgId) as Kysely<CoreMaintenanceDB>;
  const occurrence = await db.selectFrom("core_maintenance_entries").select(["id", "last_notified_at", "nag_snoozed_until", "nag_stopped_at"]).where("schedule_id", "=", s.id).where("performed_at", "is", null).executeTakeFirst();
  const preferences = await db.selectFrom("core_maintenance_preferences").selectAll().executeTakeFirst();
  const latestTerm = s.anchor ? await db.selectFrom("core_maintenance_entries").select(["id", "term_start", "term_end", "cost_cents", "currency", "quantity"]).where("schedule_id", "=", s.id).where("is_term", "=", true).orderBy(sql`term_end desc nulls last`).orderBy("performed_at", "desc").orderBy("id").executeTakeFirst() : undefined;
  const nextReminder = !s.ended_at && due.next_due_at ? nextReminderAt(due.next_due_at, s.remind, occurrence?.last_notified_at ?? null, new Date(), { ...occurrence, overdue_every: s.overdue_every ?? preferences?.overdue_every ?? "week" }) : null;
  const record = s.renewal_fields ? await platform().entities.lookup(orgId, `${s.entity_module}:${s.entity_type}`, s.entity_id) : null;
  const visible = { ...record?.fields, ...(record?.fields.metadata as Record<string, unknown> | undefined) };
  const workspaceCurrency = await platform().money.currency(orgId);
  const firstMoney = s.renewal_fields ? readMoney(visible[s.renewal_fields.cost], "amount", workspaceCurrency) : null;
  return {
    ...s,
    cancel_by: s.cancel_notice_days != null && state.current_expiry ? cancelBy(state.current_expiry, s.cancel_notice_days) : null,
    initial_term: s.renewal_fields ? { id: s.id,
      ...(Object.hasOwn(visible, s.renewal_fields.cost) ? { cost_cents: moneyForStorage(visible[s.renewal_fields.cost], "cents"), currency: firstMoney?.currency ?? workspaceCurrency } : {}),
      ...(Object.hasOwn(visible, s.renewal_fields.quantity) ? { quantity: Number(visible[s.renewal_fields.quantity]) || null } : {}),
    } : null,
    latest_term: latestTerm ?? null,
    renewal_status: s.ended_at ? "ended" : s.anchor && state.current_expiry && state.current_expiry < new Date() ? "lapsed" : "active",
    next_reminder_at: nextReminder,
    occurrence: occurrence ?? null,
    counter_every: s.counter_every == null ? null : Number(s.counter_every),
    last_done_counter: s.last_done_counter == null ? null : Number(s.last_done_counter),
    anchor: state.anchor,
    current_expiry: s.anchor ? due.next_due_at : null,
    next_expiry: nextRenewalExpiry(state),
    reminder_at: due.reminder_at,
    rule: describeRule({ anchor: state.anchor, every_n: s.every_n, every_unit: s.every_unit, counter_field: s.counter_field, counter_every: s.counter_every == null ? null : Number(s.counter_every) }, due.counter_label),
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
  if (d.expiry_field) {
    const fields = await platform().entities.fieldsFor(orgId, kind);
    if (!fields.some((f) => f.name === d.expiry_field && f.type === "date")) throw new MaintenanceRefusal("Choose a date field on this record");
    await writeExpiry(orgId, { ...d, expiry_field: d.expiry_field }, new Date(d.current_expiry! + "T12:00:00Z"));
  }
  const reading = d.counter_field ? await readCounter(orgId, kind, d.entity_id, d.counter_field) : null;
  const row = await db
    .insertInto("core_maintenance_schedules")
    .values({
      entity_module: d.entity_module,
      entity_type: d.entity_type,
      entity_id: d.entity_id,
      name: d.name,
      overdue_every: d.overdue_every ?? null,
      anchor: d.anchor ? JSON.stringify(d.anchor) as never : null,
      remind: d.remind ? JSON.stringify(d.remind) as never : null,
      expiry_field: d.expiry_field ?? null,
      current_expiry: d.anchor && !d.expiry_field ? new Date(d.current_expiry! + "T12:00:00Z") : null,
      every_n: d.anchor ? d.every_n ?? 1 : d.every_n && d.every_unit ? d.every_n : null,
      every_unit: d.anchor ? (d.every_unit ?? "year") as ScheduleRow["every_unit"] : d.every_n && d.every_unit ? (d.every_unit as ScheduleRow["every_unit"]) : null,
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
// The jobs this kind of record has had, for "What needs doing": every name
// already used on a schedule or in the service log for the kind, with how
// often and when last, and the jobs its table ships with (a bundle's
// `service_tasks`). The workspace's own come first in the picker, so a job
// typed once is offered from then on without a list anyone has to keep.
schedulesRouter.get(
  "/names",
  asyncHandler(async (req, res) => {
    const q = z.object({ kind: z.string().min(1).max(160) }).safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const ctx = tenantContext(req);
    const [entityModule, entityType] = q.data.kind.includes(":") ? q.data.kind.split(":") : [q.data.kind, q.data.kind];
    const db = tenantDb(req);
    const used = await db
      .selectFrom(
        db
          .selectFrom("core_maintenance_schedules")
          .select(["name", sql<Date>`coalesce(last_done_at, created_at)`.as("at")])
          .where("entity_module", "=", entityModule!)
          .where("entity_type", "=", entityType!)
          .unionAll(
            db
              .selectFrom("core_maintenance_entries")
              .select(["name", sql<Date>`coalesce(performed_at, created_at)`.as("at")])
              .where("entity_module", "=", entityModule!)
              .where("entity_type", "=", entityType!),
          )
          .as("u"),
      )
      .select(["u.name", sql<number>`count(*)::int`.as("uses"), sql<Date>`max(u.at)`.as("last")])
      .groupBy("u.name")
      .orderBy("last", "desc")
      // list-cap-ok: a picker's vocabulary, most recent first; the 201st job name is not one anybody scrolls to.
      .limit(200)
      .execute();
    const config = await platform().instances.configOf(ctx.org.id, entityModule!).catch(() => null);
    const shipped = Array.isArray(config?.service_tasks_default)
      ? (config.service_tasks_default as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    res.json({
      values: used.map((u) => ({ value: u.name, uses: u.uses, lastUsed: u.last ? new Date(u.last).toISOString() : null })),
      suggested: shipped,
    });
  }),
);

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
    if (!(await requireCapability(req, res, "core-maintenance:schedule"))) return;
    const parsed = ScheduleCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const row = await createSchedule(tenantDb(req), ctx.org.id, parsed.data);
    void platform().events.emit("core-maintenance.schedule.created", { orgId: ctx.org.id, scheduleId: row.id, entityId: row.entity_id });
    res.status(201).json(await present(ctx.org.id, row));
  }),
);

// AI-REACH: action core-maintenance:update-schedule
// UI-SCREEN: /instances/:name, Change renewal and the Service schedule save through core-maintenance:update-schedule so they carry their Undo
schedulesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-maintenance:update-schedule"))) return;
    const parsed = ScheduleUpdateBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = String(req.params.id ?? "");
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const before = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", id).executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
      return;
    }
    const row = await updateSchedule(db, ctx.org.id, before, parsed.data);
    res.json(await present(ctx.org.id, row));
  }),
);

/** Remove a schedule: its open occurrence goes with it, the history it rolled
 *  stays. The one way, for the record's page and the assistant alike.
 *  Returns the removed schedule's name, or null when there was none. */
export async function removeSchedule(db: Kysely<CoreMaintenanceDB>, id: string): Promise<{ name: string } | null> {
  const row = await db.deleteFrom("core_maintenance_schedules").where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
  if (!row) return null;
  await db.deleteFrom("core_maintenance_entries").where("schedule_id", "=", id).where("performed_at", "is", null).execute();
  return { name: row.name };
}

// AI-ACTION: core-maintenance:remove-schedule
schedulesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-maintenance:remove-schedule"))) return;
    const removed = await removeSchedule(tenantDb(req), String(req.params.id ?? ""));
    if (!removed) {
      res.status(404).json({ error: { code: "not_found", message: "schedule not found" } });
      return;
    }
    res.status(204).end();
  }),
);

export async function updateSchedule(db: Kysely<CoreMaintenanceDB>, orgId: string, before: ScheduleRow, d: z.infer<typeof ScheduleUpdateBody>): Promise<ScheduleRow> {
  const id = before.id;

    const next = {
      overdue_every: d.overdue_every !== undefined ? d.overdue_every : before.overdue_every,
      anchor: d.anchor !== undefined ? d.anchor : before.anchor,
      remind: d.remind !== undefined ? d.remind : before.remind,
      expiry_field: d.expiry_field !== undefined ? d.expiry_field : before.expiry_field,
      current_expiry: d.current_expiry !== undefined ? when(d.current_expiry ? d.current_expiry + "T12:00:00Z" : null) : before.current_expiry,
      name: d.name ?? before.name,
      every_n: d.every_n !== undefined ? d.every_n : before.every_n,
      every_unit: (d.every_unit !== undefined ? d.every_unit : before.every_unit) as ScheduleRow["every_unit"],
      counter_field: d.counter_field !== undefined ? d.counter_field : before.counter_field,
      counter_every: d.counter_every !== undefined ? d.counter_every : before.counter_every == null ? null : Number(before.counter_every),
    };
    if (!hasCalendar(next) && !hasCounter(next)) {
      throw new MaintenanceRefusal("A schedule needs a calendar interval or a counter interval");
    }
    if (next.anchor && (!hasCalendar(next) || !INTERVAL_UNITS.includes(next.every_unit!) || hasCounter(next))) throw new MaintenanceRefusal("Renewals need a calendar interval");
    if (next.expiry_field && !next.anchor) throw new MaintenanceRefusal("An expiry field needs a renewal anchor");
    if (next.anchor && !next.expiry_field && !next.current_expiry) throw new MaintenanceRefusal("Enter the current expiry");
    if (next.expiry_field && next.expiry_field !== before.expiry_field) {
      const defs = await platform().entities.fieldsFor(orgId, `${before.entity_module}:${before.entity_type}`);
      if (!defs.some((f) => f.name === next.expiry_field && f.type === "date")) throw new MaintenanceRefusal("Choose a date field on this record");
      if (!d.current_expiry) throw new MaintenanceRefusal("Enter the expiry for the new date field");
    }
    if (next.expiry_field && d.current_expiry) await writeExpiry(orgId, { ...before, expiry_field: next.expiry_field }, new Date(d.current_expiry + "T12:00:00Z"));
    const counterChanged = next.counter_field !== before.counter_field;
    const reading = counterChanged && next.counter_field
      ? await readCounter(orgId, `${before.entity_module}:${before.entity_type}`, before.entity_id, next.counter_field)
      : undefined;
    const row = await db
      .updateTable("core_maintenance_schedules")
      .set({
        ...next,
        anchor: next.anchor ? JSON.stringify(next.anchor) as never : null,
        remind: next.remind ? JSON.stringify(next.remind) as never : null,
        current_expiry: next.expiry_field ? null : next.current_expiry,
        ...(d.last_done_at !== undefined ? { last_done_at: when(d.last_done_at) } : {}),
        ...(reading !== undefined ? { last_done_counter: reading } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // The rule moved, so the open occurrence's date may have: make it again.
    await ensureOccurrence(db, orgId, row);
  return row;
}

export const RenewBody = z.object({
  ...TermFields,
  file_id: z.string().uuid().optional(),
  new_expiry: DateOnly.optional(),
  performed_at: z.string().datetime().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export async function renewSchedule(db: Kysely<CoreMaintenanceDB>, orgId: string, userId: string | null, s: ScheduleRow, d: z.infer<typeof RenewBody>) {
  if (!s.anchor) throw new MaintenanceRefusal("Choose a renewal schedule");
  if (d.file_id && !(await platform().files.describe(orgId, [d.file_id]))?.length) throw new MaintenanceRefusal("Choose a file in this workspace");
  const entry = await db.transaction().execute(async (tx) => {
    const current = await tx.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", s.id).forUpdate().executeTakeFirstOrThrow();
    if (current.ended_at) throw new MaintenanceRefusal("This renewal chain has ended. Add a new renewal to start again.");
    const state = await renewalState(orgId, current);
    if (d.new_expiry && d.term_end && d.new_expiry !== d.term_end) throw new MaintenanceRefusal("Choose one term end date");
    const end = d.term_end ?? d.new_expiry;
    const expiry = end ? new Date(end + "T12:00:00Z") : nextRenewalExpiry(state);
    if (!expiry || !state.current_expiry || expiry <= state.current_expiry) throw new MaintenanceRefusal("The new expiry must be after the current expiry");
    const term = await termValues(tx, orgId, current, state.current_expiry, expiry, d);
    const entry = await tx.insertInto("core_maintenance_entries").values({
      entity_module: current.entity_module, entity_type: current.entity_type, entity_id: current.entity_id,
      name: current.name, schedule_id: current.id, performed_at: d.performed_at ? new Date(d.performed_at) : new Date(),
      ...term, performed_by: userId, notes: d.notes ?? null,
      scheduled_at: state.current_expiry,
    } as never).returningAll().executeTakeFirstOrThrow();
    await rollForward(tx, orgId, entry, expiry);
    return entry;
  });
  if (d.file_id) await platform().files.attach(orgId, { fileId: d.file_id, source_module: "core-maintenance", source_type: "entry", source_id: entry.id, role: "receipt" });
  await platform().activity.log({ orgId, userId, action: "term_created", ref: { module: "core-maintenance", entityType: "term", entityId: entry.id }, diff: { name: entry.name, term_start: entry.term_start, term_end: entry.term_end } });
  const updated = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", s.id).executeTakeFirstOrThrow();
  return { entry, schedule: await present(orgId, updated) };
}

// AI-REACH: action core-maintenance:renew
schedulesRouter.post("/:id/renew", asyncHandler(async (req, res) => {
  if (!(await requireCapability(req, res, "core-maintenance:renew"))) return;
  const parsed = RenewBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const db = tenantDb(req);
  const row = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", String(req.params.id)).executeTakeFirst();
  if (!row) { res.status(404).json({ error: { code: "not_found", message: "Schedule not found" } }); return; }
  res.json(await renewSchedule(db, tenantContext(req).org.id, sessionUser(req).id, row, parsed.data));
}));

// AI-REACH: exempt form choices; list_maintenance reads the renewal itself
schedulesRouter.get("/renewal-fields", asyncHandler(async (req, res) => {
  const q = z.object({ kind: z.string().min(1).max(160), entity_id: z.string().uuid() }).safeParse(req.query);
  if (!q.success) return badBody(res, q.error);
  const orgId = tenantContext(req).org.id;
  const defs = await platform().entities.fieldsFor(orgId, q.data.kind);
  const rec = await platform().entities.lookup(orgId, q.data.kind, q.data.entity_id);
  const fields = rec?.fields ?? {};
  const meta = (fields.metadata ?? {}) as Record<string, unknown>;
  res.json({ fields: defs.filter((f) => f.type === "date" && f.name.endsWith("_expires")).map((f) => ({ key: f.name, label: f.display_label.replace(/ expires$/i, ""), value: meta[f.name] ?? fields[f.name] ?? null })) });
}));
