// CRUD for machines:machine. Common fields only — type-specific
// extension fields (hotend, tube_type, spindle, etc.) get stored
// in metadata via Pillar-E specialisation modules' contributed
// field-defs.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { pagedAnswer, readListPage, TOTAL_COLUMN } from "@cobblr/platform-contract/list-page";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata, refuseUnknownFields, withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import { isRefusal, liftUnits, unitIdsIn, mergeInto, nameUnit, releaseForDelete, splitOne, splitUnit, unitsSummary, type Refusal, type UnitsCtx } from "./units.js";

function unitsCtx(req: Parameters<typeof tenantDb>[0]): UnitsCtx {
  return { db: tenantDb(req), orgId: tenantContext(req).org.id, userId: sessionUser(req).id, instance: instanceOf(req) };
}

function answer(res: import("express").Response, out: Refusal | object) {
  if (isRefusal(out)) res.status(out.status).json({ error: out.error });
  else res.json(out);
}

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
  serial_number: z.string().max(120).nullable().optional(),
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
    const units = await unitIdsIn(db, tenantContext(req).org.id, instanceOf(req));
    const page = readListPage(req.query);
    const rows = await db
      .selectFrom("machines_machines")
      .selectAll()
      .select(sql<string>`count(*) over()`.as(TOTAL_COLUMN))
      .where("instance", "=", instanceOf(req))
      .$if(units.length > 0, (q) => q.where("id", "not in", units))
      .orderBy("name")
      .orderBy("id")
      .limit(page.limit)
      .offset(page.offset)
      .execute();
    const answer = pagedAnswer(rows, page);
    // A unit is one of its parent's N, never a machine of its own in the list.
    res.json({ ...answer, items: await liftUnits(db, tenantContext(req).org.id, answer.items) });
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
    const units = await unitsSummary(unitsCtx(req), id);
    res.json({ ...row, units: units?.units ?? [], units_not_named: units?.not_named ?? 0, unit_of: units?.unit_of ?? null });
  }),
);

machinesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    await refuseUnknownFields(req, req.body, MACHINE_NATIVE_KEYS, "machines:machine");
    const routed = routeUnknownToMetadata(req.body, MACHINE_NATIVE_KEYS);
    const parsed = MachineCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const session = sessionUser(req);
    // Create-then-place: location rides the placement seam
    // (placement-cutover-plan step 1); place() mirrors the legacy column.
    const { location_id: createLocationId, ...createRest } = parsed.data;
    const inserted = await db
      .insertInto("machines_machines")
      .values({
        ...createRest,
        instance: instanceOf(req),
        metadata: parsed.data.metadata ?? {},
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (createLocationId) {
      try {
        await platform().placement.place({
          orgId: ctx.org.id,
          containee: { kind: "machines:machine", id: inserted.id },
          container: { kind: "core-locations:location", id: createLocationId },
        });
      } catch {
        await db.updateTable("machines_machines").set({ location_id: createLocationId }).where("id", "=", inserted.id).execute();
      }
      (inserted as { location_id?: string | null }).location_id = createLocationId;
    }
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
    await refuseUnknownFields(req, req.body, MACHINE_NATIVE_KEYS, "machines:machine");
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
    // Location changes ride the placement seam (placement-cutover-plan
    // step 1); parsed.data stays intact for the activity diff.
    const { location_id: patchLocationId, ...patchRest } = parsed.data;
    const updated = await db
      .updateTable("machines_machines")
      // The custom fields MERGE into the live row (withMetadataMerged, #3625).
      .set(withMetadataMerged({ ...patchRest, updated_at: new Date() } as Record<string, unknown>) as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirstOrThrow();
    if (patchLocationId !== undefined) {
      try {
        if (patchLocationId) {
          await platform().placement.place({
            orgId: ctx.org.id,
            containee: { kind: "machines:machine", id },
            container: { kind: "core-locations:location", id: patchLocationId },
          });
        } else {
          await platform().placement.remove({
            orgId: ctx.org.id,
            containee: { kind: "machines:machine", id },
          });
        }
      } catch {
        await db.updateTable("machines_machines").set({ location_id: patchLocationId ?? null }).where("id", "=", id).execute();
      }
      (updated as { location_id?: string | null }).location_id = patchLocationId ?? null;
    }
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
    const exists = await db.selectFrom("machines_machines").select("id").where("id", "=", id).where("instance", "=", instanceOf(req)).executeTakeFirst();
    if (exists) await releaseForDelete(unitsCtx(req), id);
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

// ── units: one record standing for N machines (units.ts) ──────────────

machinesRouter.get(
  "/:id/units",
  asyncHandler(async (req, res) => {
    const out = await unitsSummary(unitsCtx(req), req.params.id!);
    if (!out) {
      res.status(404).json({ error: { code: "not_found", message: "machine not found" } });
      return;
    }
    res.json(out);
  }),
);

const NameUnit = z.object({ name: z.string().max(200).nullable().optional(), serial_number: z.string().max(120).nullable().optional() });

// AI-REACH: action machines:name-unit
// AI-ACTION: machines:name-unit
machinesRouter.post(
  "/:id/units",
  asyncHandler(async (req, res) => {
    const parsed = NameUnit.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const out = await nameUnit(unitsCtx(req), req.params.id!, parsed.data);
    if (isRefusal(out)) answer(res, out);
    else res.status(201).json(out);
  }),
);

// AI-REACH: action machines:split-unit
// AI-ACTION: machines:split-unit
machinesRouter.post(
  "/:id/split",
  asyncHandler(async (req, res) => {
    answer(res, await splitUnit(unitsCtx(req), req.params.id!));
  }),
);

// AI-REACH: action machines:split-one
// AI-ACTION: machines:split-one
machinesRouter.post(
  "/:id/split-one",
  asyncHandler(async (req, res) => {
    const parsed = NameUnit.pick({ name: true }).safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    answer(res, await splitOne(unitsCtx(req), req.params.id!, parsed.data));
  }),
);

const MergeInto = z.object({ parent_id: z.string().uuid() });

// AI-REACH: action machines:make-unit-of
// AI-ACTION: machines:make-unit-of
machinesRouter.post(
  "/:id/unit-of",
  asyncHandler(async (req, res) => {
    const parsed = MergeInto.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    answer(res, await mergeInto(unitsCtx(req), req.params.id!, parsed.data.parent_id));
  }),
);

void sql;
