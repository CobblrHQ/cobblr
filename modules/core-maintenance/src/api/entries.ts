// /api/v1/orgs/:slug/modules/core-maintenance/entries
//
// Polymorphic CRUD — every entry binds to (entity_module,
// entity_type, entity_id). The caller picks the kind: history-only
// (performed_at), scheduled-only (scheduled_at), or both (a thing
// done with a follow-up).

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { completeEntry, rollForward, reconcileSchedules, serviceTimeZone } from "../schedules-store.js";
import { PRESENT_AT_ONCE, presentEach } from "./schedules.js";
import { mapLimit } from "@cobblr/platform-contract/map-limit";
import { MaintenanceRefusal } from "../refusal.js";
import { calendarDue, serviceDay } from "../schedule.js";
import { asAddress } from "@cobblr/platform-contract/address";
import { instantFromInput } from "@cobblr/platform-contract/day";
import { CompletionBody, CounterReading } from "./completion-input.js";

export const entriesRouter = Router({ mergeParams: true });

/** An address as the picker sends it, or text on one line; null clears it.
 *  Read through asAddress, so what is stored is always the one shape. */
const AddressBody = z
  .union([z.string().max(500), z.record(z.unknown())])
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v === null) return v;
    const a = asAddress(v);
    if (!a) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "address takes a street address, like 8 Mill St, Lodi, NJ" });
    return a;
  });

/** A day (`YYYY-MM-DD`, kept as that day) or a date and time. */
const When = z
  .string()
  .nullable()
  .optional()
  .refine((v) => !v || instantFromInput(v) !== null, { message: "Give a day (YYYY-MM-DD) or a date and time." });

const EntryCreate = z
  .object({
    entity_module: z.string().min(1).max(80),
    entity_type: z.string().min(1).max(80),
    entity_id: z.string().uuid(),
    name: z.string().min(1).max(200),
    description: z.string().max(2_000).nullable().optional(),
    performed_at: When,
    counter_reading: CounterReading,
    scheduled_at: When,
    cost_cents: z.number().int().nonnegative().nullable().optional(),
    notes: z.string().max(4_000).nullable().optional(),
    recurrence_rule: z.string().max(500).nullable().optional(),
    /** The schedule this service belongs to; matched by name when absent. */
    schedule_id: z.string().uuid().nullable().optional(),
    /** Where the visit happens: an address object or one typed line. */
    address: AddressBody,
  })
  .refine(
    (d) => Boolean(d.performed_at) || Boolean(d.scheduled_at),
    {
      message: "Entry needs at least one of performed_at or scheduled_at",
      path: ["performed_at"],
    },
  );

const EntryUpdate = z.object({
  counter_reading: CounterReading,
  name: z.string().min(1).max(200).optional(), // none-refused-ok: a column of this name is NOT NULL, so a null stays refused here
  description: z.string().max(2_000).nullable().optional(),
  performed_at: When,
  scheduled_at: When,
  cost_cents: z.number().int().nonnegative().nullable().optional(),
  notes: z.string().max(4_000).nullable().optional(),
  recurrence_rule: z.string().max(500).nullable().optional(),
  address: AddressBody,
});

const ListQuery = z.object({
  entity_module: z.string().optional(),
  entity_type: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  /** "history" = performed_at is set (regardless of scheduled_at).
   *  "scheduled" = scheduled_at is set AND performed_at is null
   *  (incomplete). "all" = everything. Default: all. */
  kind: z.enum(["history", "scheduled", "all"]).default("all"),
  /** Cap scheduled-at to this many days from now (e.g. "due soon"). */
  due_within_days: z.coerce.number().int().positive().max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** The reader's zone, so an open entry's "overdue by N days" counts their
   *  days, the same count the record's schedule shows. */
  tz: z.string().max(64).optional(),
  /** Skip this many, for the next page. */
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

entriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return badBody(res, q.error);
    const filter = q.data;
    const db = tenantDb(req);
    await reconcileSchedules(db, tenantContext(req).org.id);

    let query = db
      .selectFrom("core_maintenance_entries")
      .selectAll();
    if (filter.entity_module) query = query.where("entity_module", "=", filter.entity_module);
    if (filter.entity_type) query = query.where("entity_type", "=", filter.entity_type);
    if (filter.entity_id) query = query.where("entity_id", "=", filter.entity_id);
    if (filter.kind === "history") {
      query = query.where("performed_at", "is not", null);
    } else if (filter.kind === "scheduled") {
      query = query.where("scheduled_at", "is not", null).where("performed_at", "is", null);
    }
    if (filter.due_within_days != null) {
      query = query.where(
        sql<boolean>`scheduled_at is not null and scheduled_at <= (now() + ${filter.due_within_days} * interval '1 day')`,
      );
    }
    const rows = await query
      .orderBy(
        sql<string>`coalesce(scheduled_at, performed_at, created_at)`,
        filter.kind === "scheduled" ? "asc" : "desc",
      )
      // A tiebreak, so two entries on the same date keep their order from one
      // page to the next and neither is skipped or repeated.
      .orderBy("id")
      .limit(filter.limit)
      .offset(filter.offset)
      .execute();
    // Where each open entry stands, from the one calendar rule the record's
    // schedule uses, so the list never counts its own days (#3991).
    const now = new Date();
    const zone = await serviceTimeZone(tenantContext(req).org.id, filter.tz);
    // What each entry is for, by name: a service log that says "assets·asset"
    // does not say which of a hundred assets. One lookup per record.
    const orgId = tenantContext(req).org.id;
    const titles = new Map<string, string | null>();
    await mapLimit([...new Set(rows.map((r) => `${r.entity_module}:${r.entity_type}|${r.entity_id}`))], PRESENT_AT_ONCE, async (key) => {
      const [kind, id] = key.split("|") as [string, string];
      const found = await platform().entities.lookup(orgId, kind, id).catch(() => null);
      titles.set(key, found?.title ?? null);
    });
    const schedules = new Map((await db.selectFrom("core_maintenance_schedules").selectAll().execute()).map((s) => [s.id, s]));
    const shown = [...new Set(rows.map((r) => r.schedule_id))].flatMap((id) => (id && schedules.get(id)) || []);
    const presented = new Map((await presentEach(orgId, shown, filter.tz)).map((s) => [s.id, s] as const));
    const paperwork = new Map(await mapLimit(rows.filter((r) => r.performed_at), PRESENT_AT_ONCE, async (r) => [r.id, await platform().files.listAttachments(orgId, { source_module: "core-maintenance", source_type: "entry", source_id: r.id }) ?? []] as const));
    res.json({
      items: rows.map((r) => {
        const entity_title = titles.get(`${r.entity_module}:${r.entity_type}|${r.entity_id}`) ?? null;
        const schedule = r.schedule_id ? presented.get(r.schedule_id) ?? null : null;
        const scheduled = r.scheduled_at ? serviceDay(r.scheduled_at, zone) : null;
        const entry = { ...r, scheduled_at: scheduled };
        return scheduled && !r.performed_at
          ? { ...entry, entity_title, schedule, due: { ...calendarDue(scheduled, now, filter.tz || zone), ...schedule?.due } }
          : { ...entry, entity_title, schedule, attachments: paperwork.get(r.id) ?? [] };
      }),
    });
  }),
);

entriesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_maintenance_entries")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    res.json({ ...row, scheduled_at: row.scheduled_at ? serviceDay(row.scheduled_at, await serviceTimeZone(tenantContext(req).org.id)) : null });
  }),
);

// AI-ACTION: core-maintenance:log
entriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-maintenance:log"))) return;
    const parsed = EntryCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const db = tenantDb(req);
    const zone = await serviceTimeZone(ctx.org.id);
    const scheduled = instantFromInput(parsed.data.scheduled_at);

    const row = await db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto("core_maintenance_entries")
        .values({
          entity_module: parsed.data.entity_module,
          entity_type: parsed.data.entity_type,
          entity_id: parsed.data.entity_id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          performed_at: instantFromInput(parsed.data.performed_at),
          counter_reading: parsed.data.counter_reading ?? null,
          scheduled_at: scheduled ? serviceDay(scheduled, zone) : null,
          cost_cents: parsed.data.cost_cents ?? null,
          performed_by: parsed.data.performed_at ? session.id : null,
          notes: parsed.data.notes ?? null,
          recurrence_rule: parsed.data.recurrence_rule ?? null,
          schedule_id: parsed.data.schedule_id ?? null,
          address: parsed.data.address ?? null,
        } as never)
        .returningAll()
        .executeTakeFirstOrThrow();
      // A service that belongs to a schedule rolls it forward (#3876).
      await rollForward(tx, ctx.org.id, inserted);
      return inserted;
    });

    void platform().events.emit("core-maintenance.entry.created", {
      orgId: ctx.org.id,
      entryId: row.id,
      entityModule: row.entity_module,
      entityType: row.entity_type,
      entityId: row.entity_id,
    });
    res.status(201).json(row);
  }),
);

// AI-REACH: exempt — rewrites a past service entry, which is the record a
// warranty claim or an inspection relies on; logging and completing have
// actions, and changing what was recorded stays a person's
entriesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = EntryUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const db = tenantDb(req);

    const zone = await serviceTimeZone(ctx.org.id);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.counter_reading !== undefined) patch.counter_reading = parsed.data.counter_reading;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.performed_at !== undefined) {
      patch.performed_at = instantFromInput(parsed.data.performed_at);
    }
    if (parsed.data.scheduled_at !== undefined) {
      const scheduled = instantFromInput(parsed.data.scheduled_at);
      patch.scheduled_at = scheduled ? serviceDay(scheduled, zone) : null;
    }
    if (parsed.data.cost_cents !== undefined) patch.cost_cents = parsed.data.cost_cents;
    if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes;
    if (parsed.data.recurrence_rule !== undefined) {
      patch.recurrence_rule = parsed.data.recurrence_rule;
    }
    if (parsed.data.address !== undefined) patch.address = parsed.data.address;

    // Saying an entry was done is ONE transition, from not done to done: it
    // advances the schedule once. Saving the same entry again (a retried
    // request, an edit of its notes that carries the date along) corrects
    // what was recorded and moves nothing; and when the entry is the service
    // the schedule last counted, the schedule's last-done date follows the
    // correction. The schedule is locked, so two saves at once queue (#7128).
    const row = await db.transaction().execute(async (tx) => {
      const found = await tx.selectFrom("core_maintenance_entries").select("schedule_id").where("id", "=", id).executeTakeFirst();
      if (!found) return null;
      if (found.schedule_id) await tx.selectFrom("core_maintenance_schedules").select("id").where("id", "=", found.schedule_id).forUpdate().executeTakeFirst();
      // Match completion's lock order, then read what it actually left behind.
      const before = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      if (!before) return null;
      if (before.performed_at && parsed.data.performed_at !== undefined && !patch.performed_at) {
        throw new MaintenanceRefusal("This service is already completed. Reload before editing it, or use Undo to reopen it.", 409);
      }
      if (before.schedule_id && !before.performed_at) {
        const dateChanged = parsed.data.scheduled_at !== undefined && (patch.scheduled_at instanceof Date ? patch.scheduled_at.getTime() : undefined) !== (before.scheduled_at ? serviceDay(before.scheduled_at, zone).getTime() : undefined);
        const nameChanged = parsed.data.name !== undefined && parsed.data.name !== before.name;
        if (dateChanged || nameChanged) throw new MaintenanceRefusal("This service's name and due date come from its service schedule. Change the schedule on the record instead.");
      }
      const updated = await tx.updateTable("core_maintenance_entries").set(patch as never).where("id", "=", id).returningAll().executeTakeFirst();
      if (!updated || !parsed.data.performed_at) return updated;
      if (!before.performed_at) {
        await rollForward(tx, ctx.org.id, updated);
      } else if (before.schedule_id && updated.performed_at && (updated.performed_at.getTime() !== before.performed_at.getTime() || parsed.data.counter_reading != null)) {
        await tx
          .updateTable("core_maintenance_schedules")
          .set({ last_done_at: updated.performed_at, ...(parsed.data.counter_reading != null ? { last_done_counter: parsed.data.counter_reading } : {}), updated_at: new Date() })
          .where("id", "=", before.schedule_id)
          .where("last_done_at", "=", before.performed_at)
          .execute();
      }
      return updated;
    });
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    void platform().events.emit("core-maintenance.entry.updated", {
      orgId: ctx.org.id,
      entryId: row.id,
    });
    res.json({ ...row, scheduled_at: row.scheduled_at ? serviceDay(row.scheduled_at, await serviceTimeZone(tenantContext(req).org.id)) : null });
  }),
);

// AI-REACH: exempt — erases a past service entry, the evidence a warranty or
// inspection relies on (see PATCH above); the assistant's own just-logged
// entry is undone through its card
entriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const row = await db
      .deleteFrom("core_maintenance_entries")
      .where("id", "=", id)
      .returning(["id"])
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    void platform().events.emit("core-maintenance.entry.deleted", {
      orgId: ctx.org.id,
      entryId: row.id,
    });
    res.status(204).end();
  }),
);

/** Mark a scheduled entry as done. Convenience over PATCH:
 *  performed_at = now (or supplied date), keeping scheduled_at so
 *  the history shows when it was due vs when it was actually
 *  completed. An occurrence of a schedule rolls the schedule forward
 *  and makes the next one (#3876). */
// AI-ACTION: core-maintenance:complete
// UI-SCREEN: /maintenance (the screens press the action of this name, so the press carries its Undo)
entriesRouter.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-maintenance:complete"))) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = CompletionBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const session = sessionUser(req);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const completedAt = instantFromInput(parsed.data.performed_at) ?? new Date();
    const completed = await completeEntry(db, ctx.org.id, id, session.id, completedAt, parsed.data.counter_reading);
    if (!completed) {
      res.status(404).json({ error: { code: "not_found", message: "entry not found" } });
      return;
    }
    const row = completed.row;
    res.json({ ...row, scheduled_at: row.scheduled_at ? serviceDay(row.scheduled_at, await serviceTimeZone(tenantContext(req).org.id)) : null });
  }),
);
