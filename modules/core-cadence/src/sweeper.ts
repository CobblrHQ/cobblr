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
import { platform, sourceIdKey } from "@cobblr/platform-contract";
import { cadenceState, reorderSuggested, buyLessSuggested, type CadenceEvent } from "./model.js";

const TICK_MS = 60 * 60 * 1000; // hourly: run-out is a days-scale signal
export const CADENCE_PASS = "core-cadence.sweep";
/** Don't repeat the same signal for the same record inside this window. */
const REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;

export function startCadenceSweeper(): void {
  // The walk is the kernel's (platform().sweeps, #3036): this registers the
  // per-workspace visit and its cadence and owns no timer, so the pass shares
  // one walk and one connection budget with every other pass.
  platform().sweeps.register({
    name: CADENCE_PASS,
    everyMs: TICK_MS,
    module: "core-cadence",
    visit: ({ orgId, db }) => visitWorkspace(orgId, db),
  });
  console.log(`[core-cadence] sweeper registered — every ${TICK_MS / 60_000} min`);
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
  const run = await platform().sweeps.run(CADENCE_PASS, { orgIds: opts.orgId ? [opts.orgId] : undefined });
  let scanned = 0;
  let emitted = 0;
  for (const { result } of run.results) {
    const r = result as Partial<{ scanned: number; emitted: number }> | void;
    scanned += r?.scanned ?? 0;
    emitted += r?.emitted ?? 0;
  }
  return { scanned, emitted };
}

/** One workspace, the pool already open: the pass's visit. `org` and `raw`
 *  keep their names so the body reads as it did when it was the loop's. */
async function visitWorkspace(orgId: string, raw: unknown): Promise<{ scanned: number; emitted: number }> {
  const org = { id: orgId };
  let scanned = 0;
  let emitted = 0;
  {
    {
      // Resolved once per org, and OUTSIDE the tenant closure: membership lives
      // in cobblr_meta, so fetching it per signal would be a query per record.
      const memberIds = await platform().notifications.orgMemberIds(org.id);
      {
        const tdb = raw as Kysely<SweepDB>;

        // Every record that has any history. Cheap: the ledger is small relative
        // to the records table, and this is the exact set worth evaluating.
        const tracked = await tdb
          .selectFrom("core_cadence_events")
          .select(["entity_kind", "entity_id"])
          .distinct()
          .execute();

        // "About 40% of this keeps going bad" was sent once per record, and
        // said `this` without ever naming the thing - so several of them in a
        // row were not just a stream, they were indistinguishable. Collected
        // here and sent as one named list after the sweep.
        // The entity ref rides along so ONE finding can link to the thing it
        // is about. Without it the advice named an item and gave no way to
        // reach it.
        const buyLess: Array<{ name: string; pct: number; kind: string; id: string }> = [];

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

          // Retired records generate no work. Cadence cannot look at
          // inventory_parts.archived without breaking isolation, so it asks the
          // platform for the resolved record and honours the generic `retired`
          // flag the owning module sets. A record that has been deleted
          // outright resolves to null and is skipped for the same reason: the
          // ledger keeps its history, but history is not a reason to nag.
          //
          // Checked only when a signal WOULD fire, so the happy path (nothing
          // due) still costs no lookups.
          const wants: Array<"reorder_due" | "buy_less"> = [];
          // Kept from the liveness lookup so advice can name what it is about
          // without paying for a second resolve.
          let title: string | null = null;
          if (reorderSuggested(state) || buyLessSuggested(state)) {
            let live = true;
            try {
              const resolved = await platform().entities.lookup(org.id, t.entity_kind, t.entity_id);
              live = !!resolved && resolved.retired !== true;
              title = resolved?.title ?? null;
            } catch {
              // A resolver that throws must not silence a real signal.
              live = true;
            }
            if (!live) continue;
          }

          // min_qty lives on the ITEM, not here, so the sweeper only speaks for
          // the PREDICTIVE half; the static threshold keeps firing through the
          // module's own inventory.stock.low, and the two unify downstream.
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

            // The wire engine resolves a source entity from `<kindSuffix>Id`,
            // NOT from entityId — for inventory:part that key is `partId`. Emit
            // it through the BASE kind so a record living in an instance
            // (`supplies:item`) still publishes the key the wire reads. Without
            // this the reorder.due → lists:add-item wire resolves nothing and
            // silently fires zero times, which is exactly how it shipped.
            // No raw-kind fallback: an instance kind ("supplies:item") yields
            // "itemId" while the wire reads the module's "partId", so a miss
            // must skip the emit rather than publish a key nobody listens for.
            const baseKind = await platform().entities.baseKindOf(org.id, t.entity_kind);
            if (!baseKind) {
              console.warn(`[core-cadence] no base kind for ${t.entity_kind}, skipping signal`);
              continue;
            }
            const idKey = sourceIdKey(baseKind);

            void platform().events.emit(
              signal === "reorder_due"
                ? "core-cadence.reorder.due"
                : "core-cadence.buy-less.suggested",
              {
                orgId: org.id,
                entityKind: t.entity_kind,
                entityId: t.entity_id,
                [idKey]: t.entity_id,
                daysUntilRunout: state.days_until_runout,
                onHand: state.on_hand_estimate,
                wasteRatio: state.waste_ratio,
                confidence: state.confidence,
              },
            );

            // An event with no consumer is an insight nobody receives. A wire
            // can turn reorder.due into a shopping-list line, but "most of this
            // keeps going bad" has no sensible action to fire — it is advice,
            // so it goes to the people, through the same subscription-respecting
            // dispatcher the other sweepers use.
            if (signal === "buy_less") {
              buyLess.push({
                name: title ?? "One of your items",
                pct: Math.round(state.waste_ratio * 100),
                kind: t.entity_kind,
                id: t.entity_id,
              });
            }
            emitted++;
          }
        }

        if (buyLess.length > 0) {
          const message =
            buyLess.length === 1
              ? `About ${buyLess[0]!.pct}% of ${buyLess[0]!.name} keeps going bad — worth buying less of it.`
              : `Worth buying less of these: ${buyLess
                  .map((b) => `${b.name} (${b.pct}% wasted)`)
                  .join(", ")}`;
          // One finding → the item. Several → nowhere to send you: they are
          // different things in different places, and the message already names
          // each with its waste percentage, which is the whole of the advice.
          const only = buyLess.length === 1 ? buyLess[0]! : null;
          const link = only
            ? await platform()
                .entities.detailPathForEntity(org.id, only.kind, only.id)
                .catch(() => undefined)
            : undefined;
          const destination = link
            ? { link_url: link }
            : {
                no_link_reason:
                  "advice about several items at once; each is named in the message",
              };
          for (const userId of memberIds) {
            try {
              await platform().notifications.dispatch({
                orgId: org.id,
                userId,
                ...destination,
                eventType: "core-cadence.buy-less",
                // Nothing just happened: a sweep noticed a pattern. That is the
                // clock talking, so it belongs with the rest of the day's
                // standing advice rather than as an interruption.
                triggeredBy: "schedule",
                message,
                module: "core-cadence",
                payload: { count: buyLess.length },
              });
            } catch (err) {
              console.error("[core-cadence] buy-less notify failed:", (err as Error).message);
            }
          }
        }
      }
    }
  }
  return { scanned, emitted };
}
