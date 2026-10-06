import { platform, type EntityViewer } from "@cobblr/platform-contract";
import { sql, type Kysely, type Selectable } from "kysely";
import type { z } from "zod";
import type { CoreMaintenanceDB, CoreMaintenanceEntriesTable } from "./db.js";
import { TermBody } from "./term-fields.js";
import { MaintenanceRefusal } from "./refusal.js";
import { ensureOccurrence, writeExpiry } from "./schedules-store.js";

export type TermRow = Selectable<CoreMaintenanceEntriesTable>;
export async function endRenewal(db: Kysely<CoreMaintenanceDB>, id: string, userId: string | null) {
  return db.transaction().execute(async (tx) => {
    const row = await tx.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
    if (!row) throw new MaintenanceRefusal("Renewal not found", 404);
    if (!row.anchor) throw new MaintenanceRefusal("Choose a renewal schedule");
    const ended = await tx.updateTable("core_maintenance_schedules").set({ ended_at: row.ended_at ?? new Date(), ended_by: row.ended_at ? row.ended_by : userId, updated_at: new Date() }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
    await tx.deleteFrom("core_maintenance_entries").where("schedule_id", "=", id).where("performed_at", "is", null).execute();
    return ended;
  });
}

export async function updateTerm(db: Kysely<CoreMaintenanceDB>, orgId: string, id: string, d: z.infer<typeof TermBody>) {
  if (d.file_id && !(await platform().files.describe(orgId, [d.file_id]))?.length) throw new MaintenanceRefusal("Choose a file in this workspace");
  const updated = await db.transaction().execute(async (tx) => {
    const before = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).where("is_term", "=", true).executeTakeFirst();
    if (!before?.schedule_id) throw new MaintenanceRefusal("Term not found", 404);
    const schedule = await tx.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", before.schedule_id).forUpdate().executeTakeFirst();
    if (!schedule) throw new MaintenanceRefusal("This term's renewal no longer exists");
    const current = await tx.selectFrom("core_maintenance_entries").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    const start = d.term_start ? new Date(d.term_start + "T12:00:00Z") : current.term_start;
    const end = d.term_end ? new Date(d.term_end + "T12:00:00Z") : current.term_end;
    if (start && end && end <= start) throw new MaintenanceRefusal("The term end must be after its start");
    const chain = await tx.selectFrom("core_maintenance_entries").selectAll().where("schedule_id", "=", before.schedule_id).where("is_term", "=", true).where("id", "!=", id).execute();
    if (start && end && chain.some((r) => r.term_start && r.term_end && start < r.term_end && end > r.term_start)) throw new MaintenanceRefusal("The term dates overlap another term");
    const predecessor = current.previous_term_id ? chain.find((r) => r.id === current.previous_term_id) : undefined;
    const successor = chain.find((r) => r.previous_term_id === id);
    if ((start && predecessor?.term_end && start < predecessor.term_end) || (end && successor?.term_start && end > successor.term_start)) throw new MaintenanceRefusal("The term dates overlap the renewal chain");
    const { term_start: _s, term_end: _e, file_id: _file, ...patch } = d;
    const currency = d.currency ?? current.currency;
    const row = await tx.updateTable("core_maintenance_entries").set({ ...patch, term_start: start, term_end: end,
      metadata: { ...current.metadata, ...(currency ? { money_currency_cost_cents: currency } : {}) }, updated_at: new Date(),
    }).where("id", "=", id).returningAll().executeTakeFirstOrThrow();
    if (!successor && end && d.term_end) {
      await writeExpiry(orgId, schedule, end);
      const changed = await tx.updateTable("core_maintenance_schedules").set({ ...(!schedule.expiry_field ? { current_expiry: end } : {}), updated_at: new Date() }).where("id", "=", schedule.id).returningAll().executeTakeFirstOrThrow();
      await ensureOccurrence(tx, orgId, changed);
    }
    return row;
  });
  if (d.file_id) await platform().files.attach(orgId, { fileId: d.file_id, source_module: "core-maintenance", source_type: "entry", source_id: id, role: "receipt" });
  return updated;
}

export async function presentTerms(orgId: string, rows: TermRow[]) {
  const names = await platform().accounts.displayNames(orgId, rows.flatMap((r) => r.performed_by ? [r.performed_by] : []));
  return Promise.all(rows.map(async (r) => ({ ...r, quantity: r.quantity == null ? null : Number(r.quantity),
    renewed_by: r.performed_by ? names[r.performed_by] ?? "Former member" : null,
    attachments: await platform().files.listAttachments(orgId, { source_module: "core-maintenance", source_type: "entry", source_id: r.id }) ?? [],
  })));
}

export async function termTotals(db: Kysely<CoreMaintenanceDB>, orgId: string, entityId?: string, scheduleId?: string, viewer?: EntityViewer) {
  if (viewer) {
    const page = await platform().entities.list(orgId, "core-maintenance:term", { limit: 1,
      filter: { ...(entityId ? { entity_id: entityId } : {}), ...(scheduleId ? { schedule_id: scheduleId } : {}) } }, viewer);
    if (page.items[0] && (!Object.hasOwn(page.items[0].fields, "cost_cents") || !Object.hasOwn(page.items[0].fields, "currency"))) return { per_year: [], lifetime: [], costs_hidden: true };
  }
  const currency = await platform().money.currency(orgId);
  let q = db.selectFrom("core_maintenance_entries").where("is_term", "=", true);
  if (entityId) q = q.where("entity_id", "=", entityId);
  if (scheduleId) q = q.where("schedule_id", "=", scheduleId);
  const code = sql<string>`coalesce(currency, ${currency})`;
  const year = sql<number>`extract(year from performed_at)::int`;
  const rows = await q.select([code.as("currency"), year.as("year"), sql<string>`sum(cost_cents)`.as("cost_cents")]).where("cost_cents", "is not", null).groupBy([sql`1`, sql`2`]).orderBy("year", "desc").execute();
  const lifetime = new Map<string, number>();
  for (const r of rows) lifetime.set(r.currency, (lifetime.get(r.currency) ?? 0) + Number(r.cost_cents));
  return { per_year: rows.map((r) => ({ ...r, cost_cents: Number(r.cost_cents) })), lifetime: [...lifetime].map(([currency, cost_cents]) => ({ currency, cost_cents })) };
}
