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
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      ok: true,
      result: {
        id: row.id,
        name: row.name,
        logged: performed ? "history" : "scheduled",
        performed_at: row.performed_at,
        scheduled_at: row.scheduled_at,
      },
    };
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
    return { ok: true, result: { id: row.id, name: row.name, performed_at: row.performed_at } };
  });
}
