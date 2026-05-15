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

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody } from "./util.js";

export const allocationsRouter = Router({ mergeParams: true });

const ListQuery = z.object({
  part_id: z.string().uuid().optional(),
  status: z.enum(["reserved", "consumed", "released"]).optional(),
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
        "a.reason", "a.reserved_at", "a.consumed_at", "a.released_at",
        "p.name as part_name",
      ])
      .orderBy("a.reserved_at", "desc")
      .limit(parsed.data.limit);
    if (parsed.data.part_id) q = q.where("a.part_id", "=", parsed.data.part_id);
    if (parsed.data.status) q = q.where("a.status", "=", parsed.data.status);

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
});

const StatusChange = z.object({
  status: z.enum(["consumed", "released"]),
});

allocationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = AllocCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // The part has to exist before we hand out a reservation on it.
    // FK would error eventually but we want a clean 404 not a 5xx.
    const part = await db
      .selectFrom("inventory_parts")
      .select("id")
      .where("id", "=", parsed.data.part_id)
      .executeTakeFirst();
    if (!part) {
      res.status(404).json({ error: { code: "part_not_found", message: "part not found" } });
      return;
    }

    const inserted = await db
      .insertInto("inventory_allocations")
      .values({
        part_id: parsed.data.part_id,
        qty: String(parsed.data.qty),
        target_module: parsed.data.target_module,
        target_entity_type: parsed.data.target_entity_type,
        target_entity_id: parsed.data.target_entity_id,
        reason: parsed.data.reason ?? null,
      })
      .returning([
        "id", "part_id", "qty", "status",
        "target_module", "target_entity_type", "target_entity_id",
        "reason", "reserved_at",
      ])
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "allocation_reserved",
      ref: { module: "inventory", entityType: "allocation", entityId: inserted.id },
      diff: {
        part_id: parsed.data.part_id,
        qty: parsed.data.qty,
        target: `${parsed.data.target_module}/${parsed.data.target_entity_type}/${parsed.data.target_entity_id}`,
      },
    });
    platform().events.emit("inventory.allocation.reserved", {
      orgId: ctx.org.id,
      allocationId: inserted.id,
      partId: parsed.data.part_id,
      qty: parsed.data.qty,
    });

    res.status(201).json(inserted);
  }),
);

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
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);

    // Consuming decrements stock on the underlying part — both
    // updates land in one transaction so a half-applied consumption
    // can't happen.
    const result = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("inventory_allocations")
        .select(["id", "part_id", "qty", "status"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!current) return { error: "not_found" as const };
      if (current.status !== "reserved") {
        return { error: "not_reserved" as const, current };
      }

      if (parsed.data.status === "consumed") {
        await trx
          .updateTable("inventory_parts")
          .set({
            qty: sql<string>`qty - ${current.qty}::numeric`,
            updated_at: new Date(),
          })
          .where("id", "=", current.part_id)
          .execute();
      }

      const next = await trx
        .updateTable("inventory_allocations")
        .set({
          status: parsed.data.status,
          consumed_at: parsed.data.status === "consumed" ? new Date() : null,
          released_at: parsed.data.status === "released" ? new Date() : null,
        })
        .where("id", "=", id)
        .returning([
          "id", "part_id", "qty", "status",
          "consumed_at", "released_at",
        ])
        .executeTakeFirstOrThrow();
      return { ok: true as const, next, partId: current.part_id, qty: current.qty };
    });

    if ("error" in result) {
      if (result.error === "not_found") {
        res.status(404).json({ error: { code: "not_found", message: "allocation not found" } });
        return;
      }
      res.status(409).json({
        error: {
          code: "wrong_state",
          message: `allocation is ${result.current?.status ?? "unknown"}, not reserved`,
        },
      });
      return;
    }

    const action = parsed.data.status === "consumed" ? "allocation_consumed" : "allocation_released";
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action,
      ref: { module: "inventory", entityType: "allocation", entityId: result.next.id },
      diff: { part_id: result.partId, qty: result.qty },
    });
    platform().events.emit(`inventory.${action.replace("allocation_", "allocation.")}`, {
      orgId: ctx.org.id,
      allocationId: result.next.id,
      partId: result.partId,
      qty: Number(result.qty),
    });
    if (parsed.data.status === "consumed") {
      platform().events.emit("inventory.stock.changed", {
        orgId: ctx.org.id,
        partId: result.partId,
        delta: -Number(result.qty),
        reason: "allocation_consumed",
      });
    }

    res.json(result.next);
  }),
);
