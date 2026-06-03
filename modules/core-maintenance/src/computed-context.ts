// Tier-2 context provider for COMPUTED fields. Lets a computed field on
// ANY entity surface its maintenance summary in a template:
//
//   {{maintenance.last_performed}}                      → "Oil change"
//   {{maintenance.last_performed_at | relative}}        → "2 weeks ago"
//   {{maintenance.next_scheduled}}                      → "Brake inspection"
//   {{maintenance.next_scheduled_at | relative}}        → "in 6 days"
//   {{maintenance.total_cost}}                          → "65.00"
//   {{maintenance.log_count}}                           → "7"
//
// The kernel invokes this only when a computed template on the kind
// references the `maintenance` namespace, once per entity at resolve time.
// `kind` is the entity_kind ("assets:asset"); we split it into the
// (entity_module, entity_type) pair the polymorphic log is keyed by.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

interface SummaryRow {
  last_name: string | null;
  last_performed_at: Date | null;
  next_name: string | null;
  next_scheduled_at: Date | null;
  log_count: number | string | null;
  total_cost_cents: number | string | null;
}

export function registerMaintenanceContext(): void {
  platform().entities.registerComputedContext(
    "maintenance",
    async (orgId, kind, id) => {
      const [entity_module, entity_type] = kind.split(":");
      if (!entity_module || !entity_type) return {};

      let tdb: Kysely<unknown>;
      try {
        tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
      } catch {
        return {};
      }

      try {
        // One pass: newest performed entry, soonest unfinished scheduled
        // entry, log count + total spend — all scoped to this entity.
        const compiled = sql<SummaryRow>`
          select
            (select name from core_maintenance_entries
               where entity_module = ${entity_module}
                 and entity_type   = ${entity_type}
                 and entity_id     = ${id}
                 and performed_at is not null
               order by performed_at desc limit 1) as last_name,
            (select performed_at from core_maintenance_entries
               where entity_module = ${entity_module}
                 and entity_type   = ${entity_type}
                 and entity_id     = ${id}
                 and performed_at is not null
               order by performed_at desc limit 1) as last_performed_at,
            (select name from core_maintenance_entries
               where entity_module = ${entity_module}
                 and entity_type   = ${entity_type}
                 and entity_id     = ${id}
                 and performed_at is null and scheduled_at is not null
               order by scheduled_at asc limit 1) as next_name,
            (select scheduled_at from core_maintenance_entries
               where entity_module = ${entity_module}
                 and entity_type   = ${entity_type}
                 and entity_id     = ${id}
                 and performed_at is null and scheduled_at is not null
               order by scheduled_at asc limit 1) as next_scheduled_at,
            (select count(*) from core_maintenance_entries
               where entity_module = ${entity_module}
                 and entity_type   = ${entity_type}
                 and entity_id     = ${id}) as log_count,
            (select coalesce(sum(cost_cents), 0) from core_maintenance_entries
               where entity_module = ${entity_module}
                 and entity_type   = ${entity_type}
                 and entity_id     = ${id}) as total_cost_cents
        `.compile(tdb);
        const result = (await tdb.executeQuery(compiled)) as { rows: SummaryRow[] };
        const r = result.rows[0];
        if (!r) return {};
        const cents = Number(r.total_cost_cents ?? 0);
        return {
          last_performed: r.last_name ?? "",
          last_performed_at: r.last_performed_at ?? "",
          next_scheduled: r.next_name ?? "",
          next_scheduled_at: r.next_scheduled_at ?? "",
          log_count: Number(r.log_count ?? 0),
          total_cost: (cents / 100).toFixed(2),
        };
      } catch (err) {
        // Tenant may not have the table yet (module mid-provision) — the
        // namespace just renders empty for this read.
        const msg = (err as Error).message;
        if (msg.includes("does not exist")) return {};
        throw err;
      }
    },
  );
}
