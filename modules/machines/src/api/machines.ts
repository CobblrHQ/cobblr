// CRUD for machines:machine. Common fields only — type-specific
// extension fields (hotend, tube_type, spindle, etc.) get stored
// in metadata via Pillar-E specialisation modules' contributed
// field-defs.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata } from "./route-helpers.js";

export const machinesRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router (covers both the direct mount and the instance-items dispatch
// path). Finer per-action roles can layer on top. (Audit 2026-06-26 P0 #1.)
machinesRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const MachineCreate = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().max(40).nullable().optional(),
  family: z.string().max(120).nullable().optional(),
  type: z.string().max(120).nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  state: z.string().max(40).optional(),
  excitement: z.number().int().min(0).max(5).optional(),
  image_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  quantity: z.number().int().min(0).optional(),
  location_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const MACHINE_NATIVE_KEYS = new Set(Object.keys(MachineCreate.shape));
const MachineUpdate = MachineCreate.partial();

machinesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("machines_machines")
      .selectAll()
      .where("instance", "=", instanceOf(req))
      .orderBy("name")
      .limit(500)
      .execute();
    res.json({ items });
  }),
);

machinesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("machines_machines")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "machine not found" } });
      return;
    }
    res.json(row);
  }),
);

machinesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, MACHINE_NATIVE_KEYS);
    const parsed = MachineCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    const inserted = await db
      .insertInto("machines_machines")
      .values({
        ...parsed.data,
        instance: instanceOf(req),
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: session.id,
      action: "machine_created",
      ref: { module: "machines", entityType: "machine", entityId: inserted.id },
      diff: { name: parsed.data.name, manufacturer: parsed.data.manufacturer },
    });
    platform().events.emit("machines.machine.created", {
      orgId: ctx.org.id,
      machineId: inserted.id,
    });
    res.status(201).json(inserted);
  }),
);

machinesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const routed = routeUnknownToMetadata(req.body, MACHINE_NATIVE_KEYS);
    const parsed = MachineUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const before = await db
      .selectFrom("machines_machines")
      .select("state")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "machine not found" } });
      return;
    }
    const updated = await db
      .updateTable("machines_machines")
      .set({ ...parsed.data, updated_at: new Date() } as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirstOrThrow();
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "machine_updated",
      ref: { module: "machines", entityType: "machine", entityId: id },
      diff: parsed.data,
    });
    if (parsed.data.state && parsed.data.state !== before.state) {
      platform().events.emit("machines.machine.state_changed", {
        orgId: ctx.org.id,
        machineId: id,
        from: before.state,
        to: parsed.data.state,
      });
    }
    res.json(updated);
  }),
);

machinesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const deleted = await db
      .deleteFrom("machines_machines")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning(["id", "name"])
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "machine not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "machine_deleted",
      ref: { module: "machines", entityType: "machine", entityId: id },
      // The record is gone, so the activity feed can't resolve its title —
      // carry the name in the diff so the row reads "deleted · <name>".
      diff: { name: deleted.name },
    });
    res.status(204).end();
  }),
);

void sql;
