import { poolGroupCondition } from "../pool-groups.js";
// /api/v1/orgs/:slug/modules/digifab/pools — Cobblr-native printer pools.
//
// A pool is a set of devices (possibly across connections) you can queue jobs
// onto; the assignment worker drips queued pool jobs onto free members. This
// router is just the CRUD over the pool + its members — the orchestration lives
// in assign-worker.ts.

import { Router } from "express";
import { z } from "zod";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { requireCapability } from "@cobblr/platform-contract/action-gate";

export const poolsRouter = Router({ mergeParams: true });

// GET / — every pool with its member devices.
poolsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const pools = await db.selectFrom("digifab_pools").where(poolGroupCondition()).selectAll().orderBy("created_at", "asc").execute();
    const members = await db
      .selectFrom("digifab_pool_members")
      .select(["pool_id", "connection_id", "remote_device_id", "loaded_material"])
      .execute();
    res.json({
      items: pools.map((p) => ({
        id: p.id,
        name: p.name,
        config: p.config,
        members: members
          .filter((m) => m.pool_id === p.id)
          .map((m) => ({ connection_id: m.connection_id, remote_device_id: m.remote_device_id, loaded_material: m.loaded_material })),
      })),
    });
  }),
);

const PoolCreate = z.object({ name: z.string().min(1).max(120) });

/** An empty pool: the route's POST and digifab:make-pool. */
export async function makePool(db: ReturnType<typeof tenantDb>, name: string) {
  return db.insertInto("digifab_pools").values({ name }).returning(["id", "name", "config", "created_at"]).executeTakeFirstOrThrow();
}

// AI-ACTION: digifab:make-pool
poolsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "digifab:make-pool"))) return;
    const p = PoolCreate.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const row = await makePool(tenantDb(req), p.data.name);
    res.status(201).json({ id: row.id, name: row.name, config: row.config, members: [] });
  }),
);

// AI-ACTION: digifab:remove-pool
poolsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "digifab:remove-pool"))) return;
    const db = tenantDb(req);
    await db.deleteFrom("digifab_pools").where("id", "=", req.params.id!).execute(); // members cascade
    res.status(204).end();
  }),
);

const MemberAdd = z.object({
  connection_id: z.string().uuid(),
  remote_device_id: z.string().min(1).max(200),
});

// AI-REACH: exempt — puts a printer in reach of the assignment worker, which
// sends the pool's queued jobs to it on its own; what may start unattended on
// a machine is decided by a person who can see it is clear
poolsRouter.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const m = MemberAdd.safeParse(req.body);
    if (!m.success) return void badBody(res, m.error);
    const db = tenantDb(req);
    await db
      .insertInto("digifab_pool_members")
      .values({ pool_id: req.params.id!, connection_id: m.data.connection_id, remote_device_id: m.data.remote_device_id })
      .onConflict((oc) => oc.columns(["pool_id", "connection_id", "remote_device_id"]).doNothing())
      .execute();
    res.status(201).json({ ok: true });
  }),
);

// AI-ACTION: digifab:remove-from-pool
poolsRouter.delete(
  "/:id/members/:connectionId/:deviceId",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "digifab:remove-from-pool"))) return;
    const db = tenantDb(req);
    await db
      .deleteFrom("digifab_pool_members")
      .where("pool_id", "=", req.params.id!)
      .where("connection_id", "=", req.params.connectionId!)
      .where("remote_device_id", "=", decodeURIComponent(req.params.deviceId!))
      .execute();
    res.status(204).end();
  }),
);
