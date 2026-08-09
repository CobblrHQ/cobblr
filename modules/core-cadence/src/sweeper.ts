// The cadence sweeper — what turns a stored ledger into something that speaks up.
//
// Every tick it re-derives each tracked item's state and emits the two signals
// consumers wire off:
//   core-cadence.reorder.due        → "you'll run out soon" (a bundle wires this
//                                     to lists:add-item, exactly like the shipped
//                                     inventory.stock.low wire)
//   core-cadence.buy-less.suggested → "most of this keeps going bad"
//
// Two things it must get right, both learned from sweepers that got them wrong:
//
//  1. RELEASE THE TENANT POOL. `tenants.withDb` frees the org's pool the moment
//     the closure returns. A getDb/releaseIdleDb pair holds one live connection
//     per tenant across the grace window and exhausts Postgres on a box with a
//     few hundred workspaces.
//  2. DEBOUNCE. A signal is a notification, not a state read. Re-emitting
//     "running low on milk" every hour until milk is bought trains people to
//     ignore the list. core_cadence_signals remembers when we last said it.

import { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { cadenceState, reorderSuggested, buyLessSuggested, type CadenceEvent } from "./model.js";

let intervalHandle: ReturnType<typeof setInterval> | null = null;

const TICK_MS = 60 * 60 * 1000; // hourly: run-out is a days-scale signal
/** Don't repeat the same signal for the same record inside this window. */
const REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;

export function startCadenceSweeper(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 40_000); // after boot settles
  console.log(`[core-cadence] sweeper started — every ${TICK_MS / 60_000} min`);
}

async function safeTick(): Promise<void> {
  try {
    await cadenceTick();
  } catch (err) {
    console.error("[core-cadence] sweep failed:", err);
  }
}

interface SweepDB {
  core_cadence_events: {
    entity_kind: string;
    entity_id: string;
    event_type: CadenceEvent["event_type"];
    qty_delta: string | number;
    context: NonNullable<CadenceEvent["context"]>;
    occurred_at: Date;
  };
  core_cadence_signals: {
    entity_kind: string;
    entity_id: string;
    signal: "reorder_due" | "buy_less";
    last_emitted: Date;
  };
}

/** Exported for tests + a manual poke; `orgId` limits the sweep to one workspace. */
export async function cadenceTick(
  opts: { orgId?: string } = {},
): Promise<{ scanned: number; emitted: number }> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;

  let orgsQ = meta
    .selectFrom("orgs")
    .innerJoin("org_modules as m", (j) =>
      j.onRef("m.org_id", "=", "orgs.id").on("m.module_name", "=", "core-cadence"),
    )
    .select(["orgs.id"]);
  if (opts.orgId) orgsQ = orgsQ.where("orgs.id", "=", opts.orgId);

  let orgs: { id: string }[];
  try {
    orgs = await orgsQ.execute();
  } catch {
    return { scanned: 0, emitted: 0 }; // pre-migration boot: nothing to do
  }

  let scanned = 0;
  let emitted = 0;

  for (const org of orgs) {
    // One workspace's failure must never abort the sweep for the rest.
    try {
      await platform().tenants.withDb(org.id, async (raw) => {
        const tdb = raw as Kysely<SweepDB>;

        // Every record that has any history. Cheap: the ledger is small relative
        // to the records table, and this is the exact set worth evaluating.
        const tracked = await tdb
          .selectFrom("core_cadence_events")
          .select(["entity_kind", "entity_id"])
          .distinct()
          .execute();

        const now = Date.now();
        for (const t of tracked) {
          scanned++;
          const rows = await tdb
            .selectFrom("core_cadence_events")
            .select(["event_type", "qty_delta", "context", "occurred_at"])
            .where("entity_kind", "=", t.entity_kind)
            .where("entity_id", "=", t.entity_id)
            .orderBy("occurred_at", "asc")
            .execute();

          const events: CadenceEvent[] = rows.map((r) => ({
            event_type: r.event_type,
            qty_delta: Number(r.qty_delta),
            context: r.context,
            occurred_at: new Date(r.occurred_at),
          }));
          const state = cadenceState(events);

          // min_qty lives on the ITEM, not here, so the sweeper only speaks for
          // the PREDICTIVE half; the static threshold keeps firing through the
          // module's own inventory.stock.low, and the two unify downstream.
          const wants: Array<"reorder_due" | "buy_less"> = [];
          if (reorderSuggested(state)) wants.push("reorder_due");
          if (buyLessSuggested(state)) wants.push("buy_less");

          for (const signal of wants) {
            const prev = await tdb
              .selectFrom("core_cadence_signals")
              .select(["last_emitted"])
              .where("entity_kind", "=", t.entity_kind)
              .where("entity_id", "=", t.entity_id)
              .where("signal", "=", signal)
              .executeTakeFirst();
            if (prev && now - new Date(prev.last_emitted).getTime() < REPEAT_AFTER_MS) continue;

            await tdb
              .insertInto("core_cadence_signals")
              .values({
                entity_kind: t.entity_kind,
                entity_id: t.entity_id,
                signal,
                last_emitted: new Date(),
              })
              .onConflict((oc) =>
                oc
                  .columns(["entity_kind", "entity_id", "signal"])
                  .doUpdateSet({ last_emitted: new Date() }),
              )
              .execute();

            void platform().events.emit(
              signal === "reorder_due"
                ? "core-cadence.reorder.due"
                : "core-cadence.buy-less.suggested",
              {
                orgId: org.id,
                entityKind: t.entity_kind,
                entityId: t.entity_id,
                daysUntilRunout: state.days_until_runout,
                onHand: state.on_hand_estimate,
                wasteRatio: state.waste_ratio,
                confidence: state.confidence,
              },
            );
            emitted++;
          }
        }
      });
    } catch (err) {
      console.error(`[core-cadence] org ${org.id} sweep failed:`, err);
    }
  }

  return { scanned, emitted };
}
