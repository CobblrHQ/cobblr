import { asAddress } from "@cobblr/platform-contract/address";
import { ensureBoundRenewal, RenewalFields } from "../bound-renewal.js";
import { ensureUsageSchedule } from "../usage-schedule.js";
import { z } from "zod";
// core-maintenance action handlers — the AI-reachable form of the service log.
//
// This module had NO entity kind (entries hang off the entity they service, so
// "declare your kinds" never applied) and NO actions, which left it wholly
// unwritable to the assistant: it could read a service history through
// list_maintenance and could not add to it. Asked to log an oil change, the
// only honest answer was that it had no way.
//
// Two doors, both riding the generic invoke_action rail so they inherit the
// confirm gate, the permission check and the change ledger:
//   core-maintenance:log       on the serviced record — write a history entry
//                              or schedule the next one
//   core-maintenance:complete  mark a scheduled entry done
//
// They share the same columns the HTTP route writes, so a person logging a
// service and the assistant logging one produce the same row.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreMaintenanceDB } from "../db.js";
import { completeEntry, rollForward, rolledFromOf, unrollIfCurrent } from "../schedules-store.js";
import { createSchedule, ScheduleCreateBody, ScheduleUpdateBody, RenewBody, updateSchedule, renewSchedule, removeSchedule } from "./schedules.js";
import { NagBody, CadenceBody, changeNag } from "./reminders.js";
import { moneyForStorage } from "@cobblr/platform-contract/money";
import { TermBody } from "../term-fields.js";
import { updateTerm, endRenewal } from "../terms-store.js";

import { instantFromInput } from "@cobblr/platform-contract/day";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** A date the model may phrase loosely. A bare day is that day (stored at
 *  noon UTC, never midnight: #5759); invalid is null rather than Invalid Date,
 *  which Postgres would reject with something nobody can act on. */
function when(v: unknown): Date | null {
  return instantFromInput(str(v));
}

export function registerMaintenanceHandlers(): void {
  registerUndos();
  platform().actions.registerHandler("core-maintenance.ensure-renewal", async ctx => {
    if (!ctx.entity) return { ok: false, error: "Choose the record that renews." };
    const parsed = RenewalFields.safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: "Choose the renewal fields on this collection." };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    return { ok: true, result: await ensureBoundRenewal(db, ctx.orgId, ctx.entity.kind, ctx.entity.id, parsed.data) };
  });
  platform().actions.registerHandler("core-maintenance.update-term", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const d = TermBody.safeParse({ ...args, ...(args.cost != null ? { cost_cents: moneyForStorage(args.cost, "cents") } : {}) });
    if (!d.success) return { ok: false, error: d.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const id = String(args.term_id ?? "");
    const prior = await db.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).where("is_term", "=", true).executeTakeFirst();
    const result = await updateTerm(db, ctx.orgId, id, d.data);
    // What Undo writes back: each field this edit set, as it was.
    const before: Record<string, unknown> = { term_id: id };
    if (prior) for (const k of Object.keys(d.data) as Array<keyof typeof d.data>) {
      if (k === "file_id") continue;
      const v = (prior as Record<string, unknown>)[k];
      // A start, end or currency the term never had cannot be "set back" to
      // nothing (the term keeps one); the rest go back as they were.
      if (v == null && (k === "term_start" || k === "term_end" || k === "currency")) continue;
      before[k] = v instanceof Date ? v.toISOString().slice(0, 10) : (k === "quantity" || k === "cost_cents") && v != null ? Number(v) : v ?? null;
    }
    return { ok: true, result, before, summary: "Term updated." };
  });
  platform().actions.registerHandler("core-maintenance.end-renewal", async (ctx) => {
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const id = String((ctx.args as { schedule_id?: unknown })?.schedule_id ?? "");
    return { ok: true, result: await endRenewal(db, id, ctx.userId), summary: "Renewal ended. Past terms are kept." };
  });
  platform().actions.registerHandler("core-maintenance.ensure-usage", async ctx => {
    if (!ctx.entity) return { ok: false, error: "Choose the record that keeps the usage counter." };
    const parsed = z.object({ name: z.string().trim().min(1).max(200), counter_field: z.string().min(1).max(80), counter_every: z.number().finite().positive().max(10_000_000) }).safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Give the usage threshold." };
    const [entity_module, entity_type] = ctx.entity.kind.split(":");
    if (!entity_module || !entity_type) return { ok: false, error: "Choose a record kind." };
    const defs = await platform().entities.countersFor(ctx.orgId, ctx.entity.kind);
    if (!defs.some(d => d.key === parsed.data.counter_field)) return { ok: false, error: "Choose a counter this record keeps." };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    return { ok: true, data: await ensureUsageSchedule(db, ctx.orgId, { ...parsed.data, entity_module, entity_type, entity_id: ctx.entity.id }) };
  });
  platform().actions.registerHandler("core-maintenance.renewal", async (ctx) => {
    if (!ctx.entity) return { ok: false, error: "Choose the record that expires." };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const [entity_module, entity_type] = ctx.entity.kind.split(":");
    const parsed = ScheduleCreateBody.safeParse({ ...args, entity_module, entity_type, entity_id: ctx.entity.id,
      anchor: args.anchor ?? (typeof args.current_expiry === "string" ? args.current_expiry.slice(5) : null), every_n: args.every_n ?? 1, every_unit: args.every_unit ?? "year" });
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const row = await createSchedule(db, ctx.orgId, parsed.data);
    return { ok: true, result: { schedule_id: row.id, name: row.name } };
  });
  platform().actions.registerUndo("core-maintenance.renewal", (value) => {
    const r = value as { ok?: boolean; result?: { schedule_id?: string } };
    return r.ok && r.result?.schedule_id ? { action_id: "core-maintenance:remove-schedule", args: { schedule_id: r.result.schedule_id } } : null;
  });
  platform().actions.registerHandler("core-maintenance.reminders", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const parsed = NagBody.safeParse(args);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const result = await changeNag(db, String(args.entry_id ?? ""), parsed.data);
    return { ok: true, result, summary: parsed.data.mode === "stop" ? "Reminders are off for this occurrence." : parsed.data.mode === "resume" ? "Reminders are back on." : "Reminders are snoozed." };
  });
  platform().actions.registerHandler("core-maintenance.restore-reminders", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const dates = z.object({ nag_stopped_at: z.string().datetime().nullable(), nag_snoozed_until: z.string().datetime().nullable() }).safeParse(args);
    if (!dates.success) return { ok: false, error: dates.error.message };
    await db.updateTable("core_maintenance_entries").set({ nag_stopped_at: when(dates.data.nag_stopped_at), nag_snoozed_until: when(dates.data.nag_snoozed_until) }).where("id", "=", String(args.entry_id ?? "")).where("performed_at", "is", null).execute();
    return { ok: true, summary: "Reminder settings restored." };
  });
  platform().actions.registerUndo("core-maintenance.reminders", (value) => {
    const r = value as { ok?: boolean; result?: { entry?: { id: string }; was?: { nag_stopped_at: Date | null; nag_snoozed_until: Date | null } } };
    if (!r.ok || !r.result?.entry || !r.result.was) return null;
    return { action_id: "core-maintenance:restore-reminders", args: { entry_id: r.result.entry.id, nag_stopped_at: r.result.was.nag_stopped_at?.toISOString() ?? null, nag_snoozed_until: r.result.was.nag_snoozed_until?.toISOString() ?? null } };
  });
  platform().actions.registerHandler("core-maintenance.reminder-default", async (ctx) => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "Only workspace owners and admins can change reminder defaults." };
    const parsed = CadenceBody.safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const prior = await db.selectFrom("core_maintenance_preferences").select("overdue_every").executeTakeFirst();
    await db.insertInto("core_maintenance_preferences").values({ id: true, ...parsed.data }).onConflict((c) => c.column("id").doUpdateSet(parsed.data)).execute();
    return { ok: true, summary: "Overdue reminder cadence saved.", result: parsed.data, before: { overdue_every: prior?.overdue_every ?? "week" } };
  });
  platform().actions.registerHandler("core-maintenance.update-schedule", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const parsed = ScheduleUpdateBody.safeParse(args);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const before = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", String(args.schedule_id ?? "")).executeTakeFirst();
    if (!before) return { ok: false, error: "Schedule not found" };
    const result = await updateSchedule(db, ctx.orgId, before, parsed.data);
    // What Undo writes back: each field this edit set, as the schedule had it.
    const was: Record<string, unknown> = { schedule_id: before.id };
    for (const k of Object.keys(parsed.data)) {
      const v = (before as Record<string, unknown>)[k];
      was[k] = v instanceof Date ? v.toISOString().slice(0, 10) : k === "counter_every" && v != null ? Number(v) : v ?? null;
    }
    return { ok: true, result, before: was };
  });
  platform().actions.registerHandler("core-maintenance.renew", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const parsed = RenewBody.safeParse({ ...args, ...(args.cost != null ? { cost_cents: moneyForStorage(args.cost, "cents") } : {}) });
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreMaintenanceDB>;
    const before = await db.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", String(args.schedule_id ?? "")).executeTakeFirst();
    if (!before) return { ok: false, error: "Schedule not found" };
    return { ok: true, result: await renewSchedule(db, ctx.orgId, ctx.userId, before, parsed.data) };
  });
  platform().actions.registerHandler("core-maintenance.log", async (ctx) => {
    const e = ctx.entity;
    if (!e) return { ok: false, error: "this runs on a record: say which thing was serviced" };
    const args = (ctx.args ?? {}) as Record<string, unknown>;

    const name = str(args.name);
    if (!name) return { ok: false, error: "say what was done, e.g. \"oil change\" or \"replace filter\"" };

    const performedAt = when(args.performed_at);
    const scheduledAt = when(args.scheduled_at);
    // The route requires one of the two, and for good reason: an entry that is
    // neither history nor scheduled appears in no list and reads as lost.
    // Default to "done now", which is what "log that I serviced it" means.
    const performed = performedAt ?? (scheduledAt ? null : new Date());

    // entity_module / entity_type come from the kind id ("machines:machine").
    const [entityModule, entityType] = e.kind.includes(":")
      ? [e.kind.split(":")[0]!, e.kind.split(":")[1]!]
      : [e.kind, e.kind];

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const row = await db
      .insertInto("core_maintenance_entries")
      .values({
        entity_module: entityModule,
        entity_type: entityType,
        entity_id: e.id,
        name,
        description: str(args.description),
        performed_at: performed,
        scheduled_at: scheduledAt,
        cost_cents: args.cost == null ? null : moneyForStorage(args.cost, "cents"),
        performed_by: performed ? ctx.userId : null,
        notes: str(args.notes),
        recurrence_rule: str(args.recurrence_rule),
        schedule_id: str(args.schedule_id),
        // Where it happens: the place Cobb found with find_addresses, or the
        // address as the person said it.
        address: asAddress(args.address),
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    // A service that belongs to a schedule moves it forward (#3876).
    const rolled = await rollForward(db, ctx.orgId, row);

    return {
      ok: true,
      result: {
        id: row.id,
        name: row.name,
        logged: performed ? "history" : "scheduled",
        performed_at: row.performed_at,
        scheduled_at: row.scheduled_at,
        ...(rolled ? { next_due_at: rolled.next?.scheduled_at ?? null, schedule_was: rolled.was } : {}),
      },
    };
  });

  // "Service it every 3 months" / "every 200 print hours" on the record (#3876).
  platform().actions.registerHandler("core-maintenance.schedule", async (ctx) => {
    const e = ctx.entity;
    if (!e) return { ok: false, error: "this runs on a record: say which thing to service" };
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const [entityModule, entityType] = e.kind.includes(":") ? [e.kind.split(":")[0]!, e.kind.split(":")[1]!] : [e.kind, e.kind];
    const numArg = (v: unknown): number | null => {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const parsed = ScheduleCreateBody.safeParse({
      entity_module: entityModule,
      entity_type: entityType,
      entity_id: e.id,
      name: str(args.name) ?? "",
      every_n: numArg(args.every_n) != null ? Math.round(numArg(args.every_n)!) : args.anchor ? 1 : null,
      every_unit: str(args.every_unit) ?? (args.anchor ? "year" : null),
      counter_field: str(args.counter_field),
      counter_every: numArg(args.counter_every),
      last_done_at: str(args.last_done_at),
      overdue_every: args.overdue_every,
      anchor: args.anchor,
      remind: args.remind,
      current_expiry: args.current_expiry,
      expiry_field: args.expiry_field,
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: "Say how often: every so many days, weeks, months or years, or every so much use of a counter this record keeps.",
      };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const row = await createSchedule(db, ctx.orgId, parsed.data);
    return { ok: true, result: { schedule_id: row.id, name: row.name } };
  });
  platform().actions.registerHandler("core-maintenance.remove-schedule", async (ctx) => {
    const id = String((ctx.args as { schedule_id?: unknown } | null)?.schedule_id ?? "").trim();
    if (!id) return { ok: false, error: "missing schedule_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const row = await removeSchedule(db, id);
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `Removed the ${row.name} schedule.` };
  });
  // An edit's undo writes back what it changed, so the assistant may run it
  // without a person confirming (ai-action-door: undoable runs unasked).
  const undoWith = (actionId: string) => (result: unknown) => {
    const r = result as { ok?: unknown; before?: Record<string, unknown> } | null;
    return r?.ok === true && r.before ? { action_id: actionId, args: r.before } : null;
  };
  platform().actions.registerUndo("core-maintenance.update-schedule", undoWith("core-maintenance:update-schedule"));
  platform().actions.registerUndo("core-maintenance.update-term", undoWith("core-maintenance:update-term"));
  platform().actions.registerUndo("core-maintenance.reminder-default", undoWith("core-maintenance:reminder-default"));
  platform().actions.registerUndo("core-maintenance.schedule", (result) => {
    const r = result as { ok?: unknown; result?: { schedule_id?: unknown } } | null;
    if (r?.ok !== true || typeof r.result?.schedule_id !== "string") return null;
    return { action_id: "core-maintenance:remove-schedule", args: { schedule_id: r.result.schedule_id } };
  });

  platform().actions.registerHandler("core-maintenance.complete", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const id = str(args.entry_id);
    if (!id) {
      return {
        ok: false,
        error: "pass entry_id: read the scheduled entries first, they come back with their ids",
      };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const completed = await completeEntry(db, ctx.orgId, id, ctx.userId, when(args.performed_at) ?? new Date());
    if (!completed) return { ok: false, error: "This service is no longer scheduled." };
    const { row, rolled, before } = completed;
    if (completed.skipped) return { ok: true, skipped: true, summary: "This service was already done." };
    return {
      ok: true,
      result: {
        id: row.id,
        name: row.name,
        performed_at: row.performed_at,
        ...(rolled ? { next_due_at: rolled.next?.scheduled_at ?? null, schedule_was: rolled.was } : {}),
      },
      was: { performed_at: before?.performed_at ?? null, performed_by: before?.performed_by ?? null },
    };
  });
}

// A logged entry is removed again; a completed one is put back to scheduled,
// with whatever it said before.
function registerUndos(): void {
  platform().actions.registerHandler("core-maintenance.remove-entry", async (ctx) => {
    const id = String((ctx.args as { entry_id?: unknown } | null)?.entry_id ?? "").trim();
    if (!id) return { ok: false, error: "missing entry_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const was = rolledFromOf((ctx.args as { schedule_was?: unknown } | null)?.schedule_was);
    // With the schedule locked, so an undo and a completion queue; and the
    // schedule is rolled back only when this service is still the one it
    // reflects, and only when this undo is the one that removed the entry (a
    // repeated undo changes nothing).
    const row = await db.transaction().execute(async (tx) => {
      if (was) await tx.selectFrom("core_maintenance_schedules").select("id").where("id", "=", was.schedule_id).forUpdate().executeTakeFirst();
      const gone = await tx.deleteFrom("core_maintenance_entries").where("id", "=", id).returning(["id", "name", "performed_at"]).executeTakeFirst();
      if (gone && was) await unrollIfCurrent(tx, ctx.orgId, was, gone.performed_at);
      return gone;
    });
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `Removed the ${row.name} entry.`, removed: row.id };
  });
  platform().actions.registerHandler("core-maintenance.reopen-entry", async (ctx) => {
    const a = (ctx.args as { entry_id?: unknown; performed_at?: unknown; performed_by?: unknown; schedule_was?: unknown } | null) ?? {};
    const id = String(a.entry_id ?? "").trim();
    if (!id) return { ok: false, error: "missing entry_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const was = rolledFromOf(a.schedule_was);
    const out = await db.transaction().execute(async (tx) => {
      if (was) await tx.selectFrom("core_maintenance_schedules").select("id").where("id", "=", was.schedule_id).forUpdate().executeTakeFirst();
      const before = await tx.selectFrom("core_maintenance_entries").select(["performed_at", "performed_by"]).where("id", "=", id).executeTakeFirst();
      const row = await tx
        .updateTable("core_maintenance_entries")
        .set({
          performed_at: instantFromInput(a.performed_at),
          performed_by: typeof a.performed_by === "string" && a.performed_by ? a.performed_by : null,
        } as never)
        .where("id", "=", id)
        .returning(["id", "name"])
        .executeTakeFirst();
      // An entry that was not done any more (a repeated undo) leaves the schedule as it is.
      if (row && was && before?.performed_at) await unrollIfCurrent(tx, ctx.orgId, was, before.performed_at);
      return { row, before };
    });
    if (!out.row) return { ok: false, error: `no maintenance entry with id ${id}` };
    return {
      ok: true,
      summary: `${out.row.name} is back to how it was.`,
      result: { id: out.row.id },
      was: { performed_at: out.before?.performed_at ?? null, performed_by: out.before?.performed_by ?? null },
    };
  });
  platform().actions.registerUndo("core-maintenance.log", (result) => {
    const r = (result as { ok?: unknown; result?: { id?: unknown; schedule_was?: unknown } } | null);
    if (r?.ok !== true || typeof r.result?.id !== "string") return null;
    return {
      action_id: "core-maintenance:remove-entry",
      args: { entry_id: r.result.id, ...(r.result.schedule_was ? { schedule_was: r.result.schedule_was } : {}) },
    };
  });
  const reopen = (result: unknown) => {
    const r = result as { ok?: unknown; result?: { id?: unknown; schedule_was?: unknown }; was?: { performed_at?: unknown; performed_by?: unknown } } | null;
    if (r?.ok !== true || typeof r.result?.id !== "string" || !r.was) return null;
    const at = r.was.performed_at instanceof Date ? r.was.performed_at.toISOString() : typeof r.was.performed_at === "string" ? r.was.performed_at : null;
    return { action_id: "core-maintenance:reopen-entry", args: { entry_id: r.result.id, performed_at: at, performed_by: r.was.performed_by ?? null, ...(r.result.schedule_was ? { schedule_was: r.result.schedule_was } : {}) } };
  };
  platform().actions.registerUndo("core-maintenance.complete", reopen);
  platform().actions.registerUndo("core-maintenance.reopen-entry", reopen);
}
