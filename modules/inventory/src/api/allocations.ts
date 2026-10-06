// /allocations — create (reserve) + state transitions
// (consume / release). Cross-module knock-on goes through events:
// when a stock change happens, the inventory module emits
// inventory.stock.changed; consumers (Projects, Labels, etc.)
// subscribe through their own modules.
//
// We intentionally don't enforce that target_module is in the
// platform's registered set. Soft refs by design — if the target
// goes away, the allocation row dangles and the UI shows
// "(unknown)". Cheap; the alternative (cascade-on-delete) would
// require platform-level subscription to every module's delete
// events, which is overkill for Phase 1.

import { assertStorageReady } from "./storage.js";
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";
import { recordConsumption } from "./stock-ledger.js";
import { stockMoved } from "./stock-moved.js";

export const allocationsRouter = Router({ mergeParams: true });

const ListQuery = z.object({
  part_id: z.string().uuid().optional(),
  status: z.enum(["reserved", "consumed", "released"]).optional(),
  /** Filter to allocations made AGAINST a specific target (e.g. a design /
   *  project) — lets a consuming module list "what's reserved for me". */
  target_entity_id: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

allocationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);

    let q = db
      .selectFrom("inventory_allocations as a")
      .leftJoin("inventory_parts as p", "p.id", "a.part_id")
      .select([
        "a.id", "a.part_id", "a.qty", "a.status",
        "a.target_module", "a.target_entity_type", "a.target_entity_id",
        "a.reason", "a.target_line", "a.reserved_at", "a.consumed_at", "a.released_at",
        "p.name as part_name",
      ])
      .orderBy("a.reserved_at", "desc")
      .limit(parsed.data.limit);
    if (parsed.data.part_id) q = q.where("a.part_id", "=", parsed.data.part_id);
    if (parsed.data.status) q = q.where("a.status", "=", parsed.data.status);
    if (parsed.data.target_entity_id)
      q = q.where("a.target_entity_id", "=", parsed.data.target_entity_id);

    const rows = await q.execute();
    res.json({ items: rows });
  }),
);

const AllocCreate = z.object({
  part_id: z.string().uuid(),
  qty: z.number().positive(),
  target_module: z.string().min(1).max(80),
  target_entity_type: z.string().min(1).max(80),
  target_entity_id: z.string().min(1).max(120),
  reason: z.string().max(500).optional(),
  target_line: z.string().min(1).max(120).optional(),
});

const StatusChange = z.object({
  status: z.enum(["consumed", "released"]),
});

export interface ReserveRequest {
  part_id: string;
  qty: number;
  target_module: string;
  target_entity_type: string;
  target_entity_id: string;
  reason?: string | null;
  /** The line of the target this serves (target-lines.ts). */
  target_line?: string | null;
}

/** Reserve stock of a part against something. Shared with the
 *  inventory:reserve-stock ACTION so a reservation made by hand and one made by
 *  asking are the same row, with the same activity entry and the same event. */
export async function reserveAllocation(
  db: ReturnType<typeof tenantDb>,
  orgId: string,
  userId: string,
  d: ReserveRequest,
): Promise<{ ok: true; row: Record<string, unknown> } | { ok: false; code: "part_not_found" }> {
  const inserted = await db.transaction().execute(async trx => {
    // The part has to exist before we hand out a reservation on it.
    // FK would error eventually but we want a clean 404 not a 5xx.
    const part = await trx
      .selectFrom("inventory_parts")
      .select("id")
      .where("id", "=", d.part_id)
      .forUpdate().executeTakeFirst();
    if (!part) return null;
    await assertStorageReady(trx, orgId, d.part_id);

    const inserted = await trx
      .insertInto("inventory_allocations")
      .values({
        part_id: d.part_id,
        qty: String(d.qty),
        target_module: d.target_module,
        target_entity_type: d.target_entity_type,
        target_entity_id: d.target_entity_id,
        reason: d.reason ?? null,
        target_line: d.target_line ?? null,
      })
      .returning([
        "id", "part_id", "qty", "status",
        "target_module", "target_entity_type", "target_entity_id",
        "reason", "target_line", "reserved_at",
      ])
      .executeTakeFirstOrThrow();
    return inserted;
  });
  if (!inserted) return { ok: false, code: "part_not_found" };
  await platform().activity.log({
    orgId,
    userId,
    action: "allocation_reserved",
    ref: { module: "inventory", entityType: "allocation", entityId: inserted.id },
    diff: {
      part_id: d.part_id,
      qty: d.qty,
      target: `${d.target_module}/${d.target_entity_type}/${d.target_entity_id}`,
    },
  });
  platform().events.emit("inventory.allocation.reserved", {
    orgId,
    allocationId: inserted.id,
    partId: d.part_id,
    qty: d.qty,
  });
  return { ok: true, row: inserted as unknown as Record<string, unknown> };
}


// AI-ACTION: inventory:reserve-stock
allocationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = AllocCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const outcome = await reserveAllocation(
      tenantDb(req),
      tenantContext(req).org.id,
      sessionUser(req).id,
      parsed.data,
    );
    if (!outcome.ok) {
      res.status(404).json({ error: { code: "part_not_found", message: "part not found" } });
      return;
    }
    res.status(201).json(outcome.row);
  }),
);

/** The outcome of a consume/release, with no HTTP in it. */
export type AllocationSettleOutcome =
  | { ok: true; next: { id: string; part_id: string; qty: string; status: string; consumed_at: Date | null; released_at: Date | null }; partId: string; qty: string }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "wrong_state"; status: string };

/** Consume or release ONE reserved allocation: the stock decrement, the ledger
 *  withdrawal, the status flip, the activity entry and the events, in that
 *  order and with the first three in a single transaction.
 *
 *  Extracted so the HTTP route and the inventory:settle-allocation ACTION run
 *  the SAME code. This moves stock AND writes a consumption ledger row; a
 *  second copy of it is exactly how a running balance comes to disagree with
 *  reality, which is the bug consumption-ledger.md §7.3 already records once.
 *  So there is one copy, and it is tested directly. */
export async function settleAllocation(
  db: ReturnType<typeof tenantDb>,
  orgId: string,
  userId: string,
  id: string,
  status: "consumed" | "released",
): Promise<AllocationSettleOutcome> {
  // Consuming decrements stock on the underlying part — both
  // updates land in one transaction so a half-applied consumption
  // can't happen.
  const result = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("inventory_allocations")
      .select([
        "id", "part_id", "qty", "status", "reason",
        "target_module", "target_entity_type", "target_entity_id",
      ])
      .where("id", "=", id)
      .forUpdate().executeTakeFirst();
    if (!current) return { error: "not_found" as const };
    if (current.status !== "reserved") {
      return { error: "not_reserved" as const, current };
    }

    // What consuming takes. A reservation of unopened units takes what it
    // reserved. A binding on an OPEN ball (a child unit, consumption-ledger.md
    // §3) takes what is left on the ball: its use was logged metre by metre as
    // it happened, and the binding's qty is the ball's size when it was bound,
    // so taking that as well took the same yarn off twice.
    const onPart = await trx
      .selectFrom("inventory_parts")
      .select(["qty", sql<string | null>`metadata->>'unit_of'`.as("unit_of")])
      .where("id", "=", current.part_id)
      .forUpdate().executeTakeFirst();
    const take = status === "consumed" && onPart?.unit_of ? String(Math.max(0, Number(onPart.qty))) : current.qty;

    if (status === "consumed") {
      await assertStorageReady(trx, orgId, current.part_id);
      await trx
        .updateTable("inventory_parts")
        .set({
          // Never below zero: the reservation was bounded when it was made,
          // but stock can have moved since (stock-floor.ts, and the column's
          // own CHECK).
          qty: sql<string>`greatest(0, qty - ${take}::numeric)`,
          updated_at: new Date(),
        })
        .where("id", "=", current.part_id)
        .execute();

      // The code-verified gap consumption-ledger.md §7.3 closed: consuming an
      // allocation decremented qty but never wrote the ledger, so a project
      // pulling from a bound skein produced NO statement line and that skein's
      // running balance disagreed with reality. Inside this same transaction
      // (so the decrement + the row commit or roll back together — no
      // double-count, no orphan line), one withdrawal row is written against
      // the part, attributed to the allocation's target. The reason is the
      // binding's own label ("Winter scarf") when set, else a readable target
      // descriptor.
      await recordConsumption(trx, {
        partId: current.part_id,
        delta: -Number(take),
        reason: (current.reason && current.reason.trim())
          || `for ${current.target_entity_type}`,
        sourceKind: "allocation",
        sourceId: current.id,
      });
    }

    const next = await trx
      .updateTable("inventory_allocations")
      .set({
        status,
        consumed_at: status === "consumed" ? new Date() : null,
        released_at: status === "released" ? new Date() : null,
      })
      .where("id", "=", id)
      .returning([
        "id", "part_id", "qty", "status",
        "consumed_at", "released_at",
      ])
      .executeTakeFirstOrThrow();
    return { ok: true as const, next, partId: current.part_id, qty: status === "consumed" ? take : current.qty };
  });

  if ("error" in result) {
    if (result.error === "not_found") return { ok: false, code: "not_found" };
    return { ok: false, code: "wrong_state", status: result.current?.status ?? "unknown" };
  }

  const action = status === "consumed" ? "allocation_consumed" : "allocation_released";
  await platform().activity.log({
    orgId,
    userId,
    action,
    ref: { module: "inventory", entityType: "allocation", entityId: result.next.id },
    diff: { part_id: result.partId, qty: result.qty },
  });
  platform().events.emit(status === "consumed" ? "inventory.allocation.consumed" : "inventory.allocation.released", {
    orgId,
    allocationId: result.next.id,
    partId: result.partId,
    qty: Number(result.qty),
  });
  if (status === "consumed") {
    // The statement line was written inside the transaction above; the rest
    // of what follows a count change (stock.changed, low stock) is the one
    // sequence (stock-moved.ts). A project using up a bound skein can put it
    // on the shopping list like any other use.
    const part = await db.selectFrom("inventory_parts").select(["qty", "min_qty"]).where("id", "=", result.partId).executeTakeFirst();
    if (part) {
      await stockMoved(db, orgId, {
        partId: result.partId,
        delta: -Number(result.qty),
        newQty: Number(part.qty),
        minQty: part.min_qty == null ? null : Number(part.min_qty),
        reason: "allocation_consumed",
        ledger: false,
      });
    }
  }
  return { ok: true, next: result.next, partId: result.partId, qty: result.qty };
}

// AI-ACTION: inventory:settle-allocation
allocationsRouter.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const parsed = StatusChange.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const outcome = await settleAllocation(
      tenantDb(req),
      tenantContext(req).org.id,
      sessionUser(req).id,
      id,
      parsed.data.status,
    );
    if (!outcome.ok) {
      if (outcome.code === "not_found") {
        res.status(404).json({ error: { code: "not_found", message: "allocation not found" } });
        return;
      }
      res.status(409).json({
        error: { code: "wrong_state", message: `allocation is ${outcome.status}, not reserved` },
      });
      return;
    }
    res.json(outcome.next);
  }),
);
