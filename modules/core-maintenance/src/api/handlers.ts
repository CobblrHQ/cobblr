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
import { rollForward, rolledFromOf, unroll } from "../schedules-store.js";
import { createSchedule, ScheduleCreateBody } from "./schedules.js";

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** A date the model may phrase loosely. Invalid → null rather than Invalid Date,
 *  which Postgres would reject with something nobody can act on. */
function when(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function registerMaintenanceHandlers(): void {
  registerUndos();
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
        cost_cents: typeof args.cost_cents === "number" ? Math.round(args.cost_cents) : null,
        performed_by: performed ? ctx.userId : null,
        notes: str(args.notes),
        recurrence_rule: str(args.recurrence_rule),
        schedule_id: str(args.schedule_id),
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
      every_n: numArg(args.every_n) != null ? Math.round(numArg(args.every_n)!) : null,
      every_unit: str(args.every_unit),
      counter_field: str(args.counter_field),
      counter_every: numArg(args.counter_every),
      last_done_at: str(args.last_done_at),
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
    const row = await db.deleteFrom("core_maintenance_schedules").where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
    await db.deleteFrom("core_maintenance_entries").where("schedule_id", "=", id).where("performed_at", "is", null).execute();
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `Removed the ${row.name} schedule.` };
  });
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
    const before = await db
      .selectFrom("core_maintenance_entries")
      .select(["performed_at", "performed_by"])
      .where("id", "=", id)
      .executeTakeFirst();
    const row = await db
      .updateTable("core_maintenance_entries")
      .set({
        performed_at: when(args.performed_at) ?? new Date(),
        performed_by: ctx.userId,
      } as never)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) return { ok: false, error: `no maintenance entry with id ${id}` };
    const rolled = await rollForward(db, ctx.orgId, row);
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
    const row = await db.deleteFrom("core_maintenance_entries").where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
    const was = rolledFromOf((ctx.args as { schedule_was?: unknown } | null)?.schedule_was);
    if (was) await unroll(db, ctx.orgId, was);
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `Removed the ${row.name} entry.`, removed: row.id };
  });
  platform().actions.registerHandler("core-maintenance.reopen-entry", async (ctx) => {
    const a = (ctx.args as { entry_id?: unknown; performed_at?: unknown; performed_by?: unknown } | null) ?? {};
    const id = String(a.entry_id ?? "").trim();
    if (!id) return { ok: false, error: "missing entry_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreMaintenanceDB>;
    const before = await db.selectFrom("core_maintenance_entries").select(["performed_at", "performed_by"]).where("id", "=", id).executeTakeFirst();
    const row = await db
      .updateTable("core_maintenance_entries")
      .set({
        performed_at: typeof a.performed_at === "string" && a.performed_at ? new Date(a.performed_at) : null,
        performed_by: typeof a.performed_by === "string" && a.performed_by ? a.performed_by : null,
      } as never)
      .where("id", "=", id)
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!row) return { ok: false, error: `no maintenance entry with id ${id}` };
    return {
      ok: true,
      summary: `${row.name} is back to how it was.`,
      result: { id: row.id },
      was: { performed_at: before?.performed_at ?? null, performed_by: before?.performed_by ?? null },
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
    const r = result as { ok?: unknown; result?: { id?: unknown }; was?: { performed_at?: unknown; performed_by?: unknown } } | null;
    if (r?.ok !== true || typeof r.result?.id !== "string" || !r.was) return null;
    const at = r.was.performed_at instanceof Date ? r.was.performed_at.toISOString() : typeof r.was.performed_at === "string" ? r.was.performed_at : null;
    return { action_id: "core-maintenance:reopen-entry", args: { entry_id: r.result.id, performed_at: at, performed_by: r.was.performed_by ?? null } };
  };
  platform().actions.registerUndo("core-maintenance.complete", reopen);
  platform().actions.registerUndo("core-maintenance.reopen-entry", reopen);
}
