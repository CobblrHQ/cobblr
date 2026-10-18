// DONE WHEN: every performed entry linked to an anchored schedule is a term in
// prod, staging and dev. Then remove this pass and its registration.
// BORN WITH: renewSchedule and rollForward stamp term fields on new renewals.
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { CoreMaintenanceDB } from "./db.js";
import { renewalState } from "./schedules-store.js";

export async function healTerms(orgId: string, db: Kysely<CoreMaintenanceDB>, since: Date): Promise<number> {
  const pending = await db.selectFrom("core_maintenance_entries as e").innerJoin("core_maintenance_schedules as s", "s.id", "e.schedule_id")
    .select("s.id").distinct().where("s.anchor", "is not", null).where("e.performed_at", "is not", null).where("e.is_term", "=", false).where("e.created_at", "<", since).execute();
  if (!pending.length) return 0;
  const currency = await platform().money.currency(orgId);
  let healed = 0;
  for (const { id } of pending) {
    healed += await db.transaction().execute(async (tx) => {
      const s = await tx.selectFrom("core_maintenance_schedules").selectAll().where("id", "=", id).forUpdate().executeTakeFirstOrThrow();
      const expiry = (await renewalState(orgId, s)).current_expiry;
      const rows = await tx.selectFrom("core_maintenance_entries").selectAll().where("schedule_id", "=", id).where("performed_at", "is not", null).orderBy("performed_at", "asc").orderBy("id").execute();
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!; if (r.is_term || r.created_at >= since) continue;
        const start = r.scheduled_at;
        const next = rows[i + 1];
        const candidate = next?.term_start ?? next?.scheduled_at ?? (!next ? expiry : null);
        const end = candidate && (!start || candidate > start) ? candidate : null;
        await tx.updateTable("core_maintenance_entries").set({ is_term: true, term_start: start, term_end: end,
          currency, previous_term_id: rows[i - 1]?.id ?? null, metadata: { ...r.metadata, money_currency_cost_cents: currency },
        }).where("id", "=", r.id).where("is_term", "=", false).execute();
        count++;
      }
      return count;
    });
  }
  return healed;
}
export function registerTermsHeal(): void {
  registerHealPass({ name: "core-maintenance.terms", since: "2026-10-06T20:33:43Z", shim: "modules/core-maintenance/src/heal-terms.ts", module: "core-maintenance",
    visit: ({ orgId, db, since }) => healTerms(orgId, db as Kysely<CoreMaintenanceDB>, since) });
}
