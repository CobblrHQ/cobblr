import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { instanceOf, sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { routeUnknownToMetadata, preserveServerManaged, coerceMetadata } from "./route-helpers.js";

export const recordsRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every mutating request on this
// router (covers both the direct mount and the instance-items dispatch
// path). Finer per-action roles can layer on top.
recordsRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

const RecordCreate = z.object({
  name: z.string().min(1).max(200),
  image_path: z.string().max(500).nullable().optional(),
  notes: z.string().max(8_000).nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const RECORD_NATIVE_KEYS = new Set(Object.keys(RecordCreate.shape));
const RecordUpdate = RecordCreate.partial();

recordsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const items = await db
      .selectFrom("records_records")
      .selectAll()
      .where("instance", "=", instanceOf(req))
      .orderBy("name")
      .limit(500)
      .execute();
    res.json({ items });
  }),
);

recordsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const row = await db
      .selectFrom("records_records")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "record not found" } });
      return;
    }
    res.json(row);
  }),
);

recordsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const routed = routeUnknownToMetadata(req.body, RECORD_NATIVE_KEYS);
    const parsed = RecordCreate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    // Create-then-place: location rides the placement seam
    // (placement-cutover-plan step 1); place() mirrors the legacy column.
    const { location_id: createLocationId, ...createRest } = parsed.data;
    const inserted = await db
      .insertInto("records_records")
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
          containee: { kind: "records:record", id: inserted.id },
          container: { kind: "core-locations:location", id: createLocationId },
        });
        (inserted as { location_id?: string | null }).location_id = createLocationId;
      } catch {
        await db.updateTable("records_records").set({ location_id: createLocationId }).where("id", "=", inserted.id).execute();
        (inserted as { location_id?: string | null }).location_id = createLocationId;
      }
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "record_created",
      ref: { module: "records", entityType: "record", entityId: inserted.id },
      diff: { name: parsed.data.name },
    });
    platform().events.emit("records.record.added", {
      orgId: ctx.org.id,
      recordId: inserted.id,
    });
    res.status(201).json(inserted);
  }),
);

recordsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const routed = routeUnknownToMetadata(req.body, RECORD_NATIVE_KEYS);
    const parsed = RecordUpdate.safeParse(routed);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);

    // Read the current row FIRST — the before-image for the change event AND
    // the source of truth for server-managed fields (metadata is written
    // wholesale; a stale client value must not clobber a server-stamped one).
    // Same pattern as assets' PATCH.
    const before = await db
      .selectFrom("records_records")
      .selectAll()
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "record not found" } });
      return;
    }

    const smNames = await platform().entities.serverManagedFields(ctx.org.id, "records:record");
    const beforeMeta = coerceMetadata((before as { metadata?: unknown }).metadata);
    if (parsed.data.metadata !== undefined) {
      parsed.data.metadata = preserveServerManaged(
        parsed.data.metadata as Record<string, unknown>,
        beforeMeta,
        smNames,
      );
    }

    // Location changes ride the placement seam instead of the column write;
    // parsed.data stays intact so the activity diff and the change-event bags
    // still carry the transition.
    const { location_id: patchLocationId, ...patchRest } = parsed.data;
    const updated = await db
      .updateTable("records_records")
      .set({ ...patchRest, updated_at: new Date() } as never)
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      res.status(404).json({ error: { code: "not_found", message: "record not found" } });
      return;
    }
    if (patchLocationId !== undefined) {
      try {
        if (patchLocationId) {
          await platform().placement.place({
            orgId: ctx.org.id,
            containee: { kind: "records:record", id },
            container: { kind: "core-locations:location", id: patchLocationId },
          });
        } else {
          await platform().placement.remove({
            orgId: ctx.org.id,
            containee: { kind: "records:record", id },
          });
        }
      } catch {
        await db.updateTable("records_records").set({ location_id: patchLocationId ?? null }).where("id", "=", id).execute();
      }
      (updated as { location_id?: string | null }).location_id = patchLocationId ?? null;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "record_updated",
      ref: { module: "records", entityType: "record", entityId: id },
      diff: parsed.data,
    });
    // Flat before/after bags (native columns + flattened metadata) so a
    // transition wire can compare {{event.before.x}} vs {{event.after.x}}.
    // AWAITED: a reactor writes back to this record and the client re-reads
    // right after — the wire must finish first.
    const nativeChanges: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined && k !== "metadata") nativeChanges[k] = v;
    }
    const afterMeta =
      parsed.data.metadata !== undefined
        ? ((parsed.data.metadata as Record<string, unknown>) ?? {})
        : beforeMeta;
    await platform().events.emit("records.record.updated", {
      orgId: ctx.org.id,
      recordId: id,
      before: { ...before, ...beforeMeta },
      after: { ...before, ...nativeChanges, ...afterMeta },
    });
    res.json(updated);
  }),
);

recordsRouter.delete(
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
      .deleteFrom("records_records")
      .where("id", "=", id)
      .where("instance", "=", instanceOf(req))
      .returning("id")
      .executeTakeFirst();
    if (!deleted) {
      res.status(404).json({ error: { code: "not_found", message: "record not found" } });
      return;
    }
    await platform().activity.log({
      orgId: ctx.org.id,
      userId: sessionUser(req).id,
      action: "record_deleted",
      ref: { module: "records", entityType: "record", entityId: id },
    });
    platform().events.emit("records.record.deleted", {
      orgId: ctx.org.id,
      recordId: id,
    });
    res.status(204).end();
  }),
);
