// Calendar source: orders that haven't arrived yet, by expected_arrival —
// "the filament ships Thursday". Registered at boot; the kernel calls it for
// the requested window. purchases never imports the calendar — it contributes
// through the platform seam.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CalendarEvent } from "@cobblr/platform-contract";

interface EtaRow {
  id: string;
  vendor: string | null;
  order_number: string | null;
  expected_arrival: string;
}

export function registerPurchasesCalendarSource(): void {
  platform().calendar.registerSource("order", async (orgId, fromISO, toISO) => {
    let tdb: Kysely<unknown>;
    try {
      tdb = (await platform().tenants.getDb(orgId)) as Kysely<unknown>;
    } catch {
      return [];
    }
    try {
      const compiled = sql<EtaRow>`
        select id, vendor, order_number, expected_arrival
        from purchases_orders
        where expected_arrival is not null
          and arrived_at is null
          and status <> 'cancelled'
          and expected_arrival::date >= ${fromISO}::date
          and expected_arrival::date <= ${toISO}::date
        order by expected_arrival asc
      `.compile(tdb);
      const { rows } = (await tdb.executeQuery(compiled)) as { rows: EtaRow[] };
      return rows.map<CalendarEvent>((r) => {
        const label = r.vendor || "Order";
        const num = r.order_number ? ` #${r.order_number}` : "";
        return {
          id: `order:${r.id}`,
          title: `${label}${num} arrives`,
          date: new Date(r.expected_arrival).toISOString().slice(0, 10),
          allDay: true,
          source: "order",
          category: "order",
          entityModule: "purchases",
          entityType: "order",
          entityId: r.id,
        };
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("does not exist")) return [];
      throw err;
    }
  });
}
