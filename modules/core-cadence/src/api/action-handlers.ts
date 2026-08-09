// The invokable side of cadence, so a wire (a receipt commit, a shopping-list
// check-off) or an AI surface can append a ledger fact without speaking this
// module's HTTP shape — and, critically, without either side importing the other
// (isolation: events -> wires -> actions).
//
// One handler only. Reading the derived state is a GET; recording is the single
// mutation, because every signal is a pure function of the ledger.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreCadenceDB } from "../db.js";

let registered = false;

const EVENT_TYPES = new Set(["purchase", "consume", "adjust", "discard"]);
const CONTEXTS = new Set(["normal", "one_off", "bulk", "faster"]);
const SOURCES = new Set(["scan", "list", "manual", "wire", "checkin"]);

export function registerCadenceActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-cadence.record-event", async (ctx) => {
    const args = (ctx.args as Record<string, unknown> | null) ?? {};
    const entity = requireActionEntity(ctx);

    const eventType = String(args.event_type ?? "").trim();
    if (!EVENT_TYPES.has(eventType)) {
      return { ok: false, error: `event_type must be one of ${[...EVENT_TYPES].join(", ")}` };
    }
    const qtyDelta = Number(args.qty_delta);
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
    const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreCadenceDB>;
    const row = await db
      .insertInto("core_cadence_events")
      .values({
        entity_kind: entity.kind,
        entity_id: entity.id,
        event_type: eventType as "purchase" | "consume" | "adjust" | "discard",
        qty_delta: qtyDelta,
        context: context as "normal" | "one_off" | "bulk" | "faster",
        source: source as "scan" | "list" | "manual" | "wire" | "checkin",
        unit_price: Number.isFinite(price) ? price : null,
        occurred_at: occurredAt,
        user_id: ctx.userId ?? null,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    return { ok: true, event_id: row.id, recorded: eventType, qty_delta: qtyDelta };
  });
}
