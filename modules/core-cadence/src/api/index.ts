// Default-exported Router, mounted at
//   /api/v1/orgs/:slug/modules/core-cadence/
// (requireAuth + withTenant pre-applied by the platform).
//
// Two verbs only: append a fact to the ledger, and read the derived state for a
// record. Every signal is computed from history by the pure engine (../model.js),
// so there is no cached state to invalidate and a recompute is always correct.

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { tenantDb, tenantContext, sessionUserId, loadEvents } from "../db.js";
import { cadenceTick } from "../sweeper.js";
import {
  cadenceState,
  reorderSuggested,
  buyLessSuggested,
  classifyRepurchase,
} from "../model.js";
import { requireRole } from "./util.js";
import { registerCadenceActionHandlers } from "./action-handlers.js";

// Side effect on import: the record-event action handler.
registerCadenceActionHandlers();

const router = Router({ mergeParams: true });

const RecordBody = z.object({
  entity_kind: z.string().min(1).max(120),
  entity_id: z.string().uuid(),
  event_type: z.enum(["purchase", "consume", "adjust", "discard"]),
  qty_delta: z.number().finite(),
  context: z.enum(["normal", "one_off", "bulk", "faster"]).optional(),
  source: z.enum(["scan", "list", "manual", "wire", "checkin"]).optional(),
  unit_price: z.number().nonnegative().nullable().optional(),
  /** ISO date. Defaults to now; a receipt should pass its OWN date. */
  occurred_at: z.string().datetime().optional(),
});

// AI-REACH: action core-cadence:record-event — the same append, exposed as an
// action so Ask Cobb / MCP / wires drive it without speaking this HTTP shape.
router.post("/events", async (req: Request, res: Response, next) => {
  try {
    // A read-only guest must not be able to rewrite the workspace's cadence:
    // a forged purchase moves the learned rate for everyone.
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = RecordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { code: "invalid_body", message: "Bad request body", details: parsed.error.issues },
      });
      return;
    }
    const b = parsed.data;
    const row = await tenantDb(req)
      .insertInto("core_cadence_events")
      .values({
        entity_kind: b.entity_kind,
        entity_id: b.entity_id,
        event_type: b.event_type,
        qty_delta: b.qty_delta,
        context: b.context ?? "normal",
        source: b.source ?? "manual",
        unit_price: b.unit_price ?? null,
        ...(b.occurred_at ? { occurred_at: new Date(b.occurred_at) } : {}),
        user_id: sessionUserId(req),
      })
      .returning(["id", "occurred_at"])
      .executeTakeFirstOrThrow();
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

/**
 * The derived signals for one record.
 *
 * `min_qty` / `lead_time_days` come from the caller because they belong to the
 * ITEM (its bundle/field defs), not to cadence — that is what keeps the reorder
 * signal unified instead of cadence growing its own competing threshold.
 */
router.get("/state/:kind/:id", async (req: Request, res: Response, next) => {
  try {
    const q = z
      .object({
        min_qty: z.coerce.number().optional(),
        lead_time_days: z.coerce.number().min(0).optional(),
        /** "the stock still on the shelf is already past its expiry date."
         *  Only the caller knows this - cadence keeps a ledger, not the item's
         *  expiry field - so a surface that HAS the date (a scan commit on a
         *  perishable) passes it and gets `discard` instead of the three-way
         *  prompt. Without it that branch of classifyRepurchase is unreachable,
         *  and food that rotted gets recorded as food that got eaten, which
         *  raises the rate and tells you to buy MORE of what you threw away. */
        expired: z.enum(["true", "false"]).optional(),
      })
      .safeParse(req.query);
    const minQty = q.success ? q.data.min_qty : undefined;
    const leadTimeDays = q.success ? q.data.lead_time_days : undefined;
    const expired = q.success && q.data.expired === "true";

    const events = await loadEvents(tenantDb(req), req.params.kind!, req.params.id!);
    const state = cadenceState(events);
    res.json({
      ...state,
      reorder_suggested: reorderSuggested(state, {
        minQty: minQty ?? null,
        ...(leadTimeDays !== undefined ? { leadTimeDays } : {}),
      }),
      buy_less_suggested: buyLessSuggested(state),
      /** What a NEW purchase right now would mean — drives the over-buy prompt. */
      repurchase_means: classifyRepurchase(state, { expired }),
      event_count: events.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Run one sweep for THIS workspace, now.
 *
 * The sweeper is hourly, which makes the predictive half of cadence effectively
 * untestable: you cannot wait an hour in an e2e, and "the sweeper started" in a
 * log says nothing about whether a tick actually emits anything. Scoped to the
 * caller's org and owner/admin only, so it is a diagnostic, not a lever on
 * anyone else's data. Idempotent by the same 24h debounce the timer uses.
 */
// AI-REACH: exempt — an operator diagnostic that forces the hourly sweep to run
// now; it creates nothing and an agent has no reason to trigger it.
router.post("/sweep", async (req: Request, res: Response, next) => {
  try {
    if (!requireRole(req, res, "owner", "admin")) return;
    const result = await cadenceTick({ orgId: tenantContext(req).org.id });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
