// The invokable side of cadence, so a wire (a receipt commit, a shopping-list
// check-off) or an AI surface can append a ledger fact without speaking this
// module's HTTP shape — and, critically, without either side importing the other
// (isolation: events -> wires -> actions).
//
// One handler only. Reading the derived state is a GET; recording is the single
// mutation, because every signal is a pure function of the ledger.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import { statedQuantity } from "@cobblr/platform-contract/stated-quantity";
import type { Kysely } from "kysely";
import type { CoreCadenceDB } from "../db.js";
import { recordCadenceEvent } from "../record.js";

let registered = false;

const EVENT_TYPES = new Set(["purchase", "consume", "adjust", "discard"]);
const CONTEXTS = new Set(["normal", "one_off", "bulk", "faster"]);
const SOURCES = new Set(["scan", "list", "manual", "wire", "checkin"]);

export function registerCadenceActionHandlers(): void {
  registerUndos();
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-cadence.record-event", async (ctx) => {
    const args = (ctx.args as Record<string, unknown> | null) ?? {};
    const entity = requireActionEntity(ctx);

    const eventType = String(args.event_type ?? "").trim();
    if (!EVENT_TYPES.has(eventType)) {
      return { ok: false, error: `event_type must be one of ${[...EVENT_TYPES].join(", ")}` };
    }
    // "I got 3", stated on the gesture, beats the wire's fixed qty_delta.
    const stated = statedQuantity((ctx.event?.payload as { quantity?: unknown } | undefined)?.quantity, args.qty_delta);
    const qtyDelta = stated ?? Number(args.qty_delta);
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
      return { ok: false, error: "qty_delta must be a non-zero number" };
    }

    const context = String(args.context ?? "normal");
    const source = String(args.source ?? "wire");
    if (!CONTEXTS.has(context)) return { ok: false, error: `unknown context "${context}"` };
    if (!SOURCES.has(source)) return { ok: false, error: `unknown source "${source}"` };

    // A receipt carries its OWN date; defaulting to now would compress real
    // history into today and flatten the learned rate.
    const occurredAt =
      typeof args.occurred_at === "string" && !Number.isNaN(Date.parse(args.occurred_at))
        ? new Date(args.occurred_at)
        : new Date();

    const price = Number(args.unit_price);
    // Through the SAME write as the route and the event subscriber. This used
    // to insert directly and pass entity.kind straight through, skipping the
    // baseKindOf normalisation the route does - so a wire or an AI invocation
    // filed a skinned instance ("tea:item") under a different identity than a
    // scan of the same item ("inventory:part"), which is precisely the split
    // ledger the route's comment describes. One tea, two histories, and every
    // reader got whichever half it happened to ask for.
    const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreCadenceDB>;
    const row = await recordCadenceEvent(db, ctx.orgId, ctx.userId ?? null, {
      entity_kind: entity.kind,
      entity_id: entity.id,
      event_type: eventType as "purchase" | "consume" | "adjust" | "discard",
      qty_delta: qtyDelta,
      context: context as "normal" | "one_off" | "bulk" | "faster",
      source: source as "scan" | "list" | "manual" | "wire" | "checkin",
      unit_price: Number.isFinite(price) ? price : null,
      occurred_at: occurredAt.toISOString(),
      ...(typeof args.source_ref === "string" && args.source_ref.trim() ? { source_ref: args.source_ref.trim() } : {}),
    });

    return { ok: true, event_id: row.id, recorded: eventType, qty_delta: qtyDelta };
  });
}

function registerUndos(): void {
  platform().actions.registerHandler("core-cadence.remove-event", async (ctx) => {
    const a = (ctx.args as { event_id?: unknown; source_ref?: unknown } | null) ?? {};
    const id = String(a.event_id ?? "").trim();
    const ref = String(a.source_ref ?? "").trim();
    if (!id && !ref) return { ok: false, error: "missing event_id or source_ref" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreCadenceDB>;
    if (id) {
      const row = await db.deleteFrom("core_cadence_events").where("id", "=", id).returning(["id", "event_type"]).executeTakeFirst();
      if (!row) return { ok: true, skipped: true, reason: "already gone" };
      return { ok: true, summary: `Removed the recorded ${row.event_type}.`, removed: row.id };
    }
    // By reference: every row the same cause filed. The caller (a scan attach's
    // undo) never held an id, because the row arrived through the
    // stock.observed subscriber; what it holds is its own reference.
    const rows = await db.deleteFrom("core_cadence_events").where("source_ref", "=", ref).returning(["id", "event_type"]).execute();
    if (rows.length === 0) return { ok: true, skipped: true, reason: "already gone" };
    const kinds = [...new Set(rows.map((r) => r.event_type))].join(", ");
    return { ok: true, summary: `Removed the recorded ${kinds}.`, removed: rows.map((r) => r.id), source_ref: ref };
  });
  platform().actions.registerUndo("core-cadence.record-event", (result) => {
    const r = result as { ok?: unknown; event_id?: unknown } | null;
    if (r?.ok !== true || typeof r.event_id !== "string") return null;
    return { action_id: "core-cadence:remove-event", args: { event_id: r.event_id } };
  });
}
