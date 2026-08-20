// The cadence signals, as computed fields.
//
// The engine has always been able to answer "how often do I replenish this" and
// "when does it run out"; until now the only way to ask was an HTTP call to
// /state, which no table, view or app block can make. So the numbers existed and
// nobody could see them. docs/design-decisions/consumption-cadence.md called for
// exactly this ("Signals out ... exposed as read-only computed/derived fields")
// and it is the last piece of that design.
//
// A tier-2 computed context is the right seam: a bundle writes
// {{ cadence.replenish_every_days }} in a field def and the kernel calls this
// only for kinds whose templates actually reference the namespace. Nothing
// imports core-cadence, so module isolation holds and any kind with a quantity
// can use it.

import { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { cadenceState } from "./model.js";
import type { CadenceEvent } from "./model.js";

interface EventsDB {
  core_cadence_events: {
    entity_kind: string;
    entity_id: string;
    event_type: CadenceEvent["event_type"];
    qty_delta: string | number;
    context: NonNullable<CadenceEvent["context"]>;
    occurred_at: Date;
  };
}

/** Round to one decimal: these are estimates from a handful of shopping trips,
 *  and "every 23.4 days" claims a precision the data does not have. */
const round1 = (n: number | null): number | null =>
  n == null ? null : Math.round(n * 10) / 10;

export function registerCadenceComputedContext(): void {
  platform().entities.registerComputedContext("cadence", async (orgId, kind, id) => {
    // `kind` here is the PRESENTATION kind: "inventory:part" for the default
    // instance but "<instance>:item" for a skinned one ("tea:item"). Everything
    // that WRITES the ledger — the bundle wires, the scan attach path, the
    // /events route — writes the BASE kind, so matching on the presentation
    // kind finds no rows at all. The failure is silent and renders exactly like
    // the honest "still learning" empty state, so a whole table of blank
    // columns looks like a cold start instead of a bug. Ask for both.
    const base = await platform().entities.baseKindOf(orgId, kind).catch(() => kind);
    const kinds = base === kind ? [kind] : [kind, base];

    // withDb hands back an opaque handle; the sweeper casts the same way.
    return await platform().tenants.withDb(orgId, async (raw) => {
      const db = raw as Kysely<EventsDB>;
      const rows = await db
        .selectFrom("core_cadence_events")
        .select(["event_type", "qty_delta", "context", "occurred_at"])
        .where("entity_kind", "in", kinds)
        .where("entity_id", "=", id)
        .orderBy("occurred_at", "asc")
        .execute();

      const events: CadenceEvent[] = rows.map((r) => ({
        event_type: r.event_type,
        qty_delta: Number(r.qty_delta),
        context: r.context,
        occurred_at: new Date(r.occurred_at),
      }));

      const s = cadenceState(events);
      // While confidence is "learning" the engine returns nulls rather than a
      // fabricated date; a computed field renders that as an empty cell, which
      // is the honest answer and the one the cold-start rule asks for.
      return {
        replenish_every_days: round1(s.replenish_every_days),
        days_until_runout: round1(s.days_until_runout),
        on_hand_estimate: round1(s.on_hand_estimate),
        waste_ratio: round1(s.waste_ratio * 100),
        confidence: s.confidence,
        /** Purchases seen. Useful in a view to explain a blank run-out column:
         *  "we have only ever seen you buy this once". */
        purchases: events.filter((e) => e.event_type === "purchase").length,
      };
    });
  });
}
